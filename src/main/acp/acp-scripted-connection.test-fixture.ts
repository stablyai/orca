import type { ProviderProcessExit } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { AcpAgentConnectionOptions } from './acp-agent-connection'
import { AcpConnectionClosedError } from './acp-errors'
import { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpStructuredConnection } from './acp-structured-connection'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
export const PID = 4242

/** Real in-memory protocol with separate stream, process-exit and connection-loss lifecycles. */
export class FakeAcpChild extends AcpSessionRuntime implements AcpStructuredConnection {
  readonly agent: AcpScriptedAgent
  readonly pid: number | undefined = PID
  readonly spawned = Promise.resolve()
  stderr = ''
  processTreeUnproven = false
  private exitListeners: ((exit: ProviderProcessExit) => void)[] = []
  private closing = false
  private lostWith: Error | undefined
  private exitedWith: ProviderProcessExit | null = null
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
  override close(error?: Error): Promise<boolean> {
    this.closes += 1
    this.closing ||= this.exitedWith === null
    this.drainNotifications(error)
    return this.proveClose().finally(() => super.close(error))
  }
  exit(status: ProviderProcessExit = FAKE_EXIT): void {
    if (this.exitedWith) {
      return
    }
    this.exitedWith = status
    const error =
      this.lostWith ?? new AcpConnectionClosedError(this.stderr || `${this.launch.command} exited`)
    super.close(error)
    this.connectionOptions.onExit?.(error, { expected: this.closing, exit: status })
    for (const listener of this.exitListeners.splice(0)) {
      listener(status)
    }
  }
  private lost(error: Error): void {
    this.lostWith ??= error
    if (this.closing || this.exitedWith) {
      return
    }
    this.connectionOptions.onClose?.(error)
  }
}

const FAKE_EXIT: ProviderProcessExit = { code: 0, signal: null, processless: false }
