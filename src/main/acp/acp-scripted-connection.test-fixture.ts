import type { ProviderProcessExit } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import {
  withProviderSpawnAbsence,
  type ProviderSpawnAbsence
} from '../provider-process/provider-executable-missing'
import type { AcpAgentConnectionOptions, AcpCloseOutcome } from './acp-agent-connection'
import { AcpConnectionClosedError } from './acp-errors'
import { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpStructuredConnection } from './acp-structured-connection'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
export const PID = 4242

/** Real in-memory protocol with separate stream, process-exit and connection-loss lifecycles. */
export class FakeAcpChild extends AcpSessionRuntime implements AcpStructuredConnection {
  readonly agent: AcpScriptedAgent
  readonly pid: number | undefined = PID
  spawnAbsence: ProviderSpawnAbsence | null = null
  readonly spawned = Promise.resolve()
  stderr = ''
  processTreeUnproven = false
  private exitListeners: ((exit: ProviderProcessExit) => void)[] = []
  private closing = false
  private lostWith: Error | undefined
  private exitedWith: ProviderProcessExit | null = null
  private inputCompletion?: Promise<void>
  private closeAttempt?: Promise<AcpCloseOutcome>
  private exitPublication?: Promise<void>
  closes = 0

  constructor(
    readonly launch: ProviderProcessLaunch,
    private readonly connectionOptions: AcpAgentConnectionOptions,
    agent = new AcpScriptedAgent()
  ) {
    const lifecycle: { child: FakeAcpChild | null } = { child: null }
    super(agent.stdout, agent.stdin, {
      ...connectionOptions,
      peer: { ...connectionOptions.peer, closeOnInputEnd: false },
      onClose: (error) => lifecycle.child?.lost(error)
    })
    lifecycle.child = this
    this.agent = agent
  }

  get exited() {
    return this.exitedWith !== null
  }
  onExit(listener: (exit: ProviderProcessExit) => void): void {
    if (this.exitedWith) {
      listener(this.exitedWith)
    } else {
      this.exitListeners.push(listener)
    }
  }
  stderrTail(): string {
    return this.stderr
  }
  get lastCloseResult(): AcpCloseOutcome['physical'] | null {
    return { root: this.exited ? 'exited' : 'live', tree: null }
  }
  get exitStatus(): ProviderProcessExit | null {
    return this.exitedWith
  }
  pauseReading(): void {
    this.agent.stdout.pause()
  }
  resumeReading(): void {
    this.agent.stdout.resume()
  }
  /** Override to simulate a close without proven exit. */
  proveClose = async (): Promise<boolean> => {
    this.exit()
    return true
  }
  closeOutcome(error?: Error): Promise<AcpCloseOutcome> {
    if (this.closeAttempt) {
      return this.closeAttempt
    }
    const attempt = this.performClose(error)
    this.closeAttempt = attempt
    void attempt.then(
      (outcome) => {
        if (!outcome.accepted) {
          this.closeAttempt = undefined
        }
      },
      () => {
        this.closeAttempt = undefined
      }
    )
    return attempt
  }
  private async performClose(error?: Error): Promise<AcpCloseOutcome> {
    this.closes += 1
    this.closing ||= this.exitedWith === null
    this.drainNotifications(error)
    const accepted = await this.proveClose()
    await this.completeInput(error)
    await this.exitPublication
    return {
      accepted,
      physical: this.lastCloseResult ?? { root: this.exited ? 'exited' : 'live', tree: null },
      receive: { state: 'complete' }
    }
  }
  override async close(error?: Error): Promise<boolean> {
    const outcome = await this.closeOutcome(error)
    if (outcome.receive.state === 'failed') {
      throw outcome.receive.error
    }
    return outcome.accepted
  }
  exit(status: ProviderProcessExit = FAKE_EXIT): void {
    if (this.exitedWith) {
      return
    }
    this.exitedWith = status
    // As the real connection: a spawn ENOENT marks the exit error with what it proved absent.
    const error = withProviderSpawnAbsence(
      this.lostWith ?? new AcpConnectionClosedError(this.stderr || `${this.launch.command} exited`),
      this.spawnAbsence
    )
    const inputDone = this.completeInput(error)
    this.exitPublication = Promise.resolve(
      this.connectionOptions.onExit?.(error, { expected: this.closing, exit: status, inputDone })
    )
    for (const listener of this.exitListeners.splice(0)) {
      listener(status)
    }
  }
  private completeInput(error?: Error): Promise<void> {
    this.inputCompletion ??= Promise.resolve().then(() => {
      super.close(error)
      this.connectionOptions.onInputComplete?.(this.lostWith ?? error)
    })
    return this.inputCompletion
  }
  private lost(error: Error): void {
    this.lostWith ??= error
    void this.completeInput(error)
    if (this.closing || this.exitedWith) {
      return
    }
    this.connectionOptions.onClose?.(error)
  }
}

const FAKE_EXIT: ProviderProcessExit = { code: 0, signal: null, processless: false }
