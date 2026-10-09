import type { ProviderProcessExit } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { AcpAgentConnectionOptions } from './acp-agent-connection'
import { AcpConnectionClosedError } from './acp-errors'
import { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpStructuredConnection } from './acp-structured-connection'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
export const PID = 4242

/** A scripted agent behind the connection surface: the real protocol runtime over in-memory stdio,
 *  with the process lifecycle `AcpAgentConnection` gives it (stdout EOF is not exit; the exit closes
 *  the protocol with the agent's last words; a protocol failure while it runs is `onClose`). */
export class FakeAcpChild extends AcpSessionRuntime implements AcpStructuredConnection {
  readonly agent: AcpScriptedAgent
  readonly pid: number | undefined = PID
  readonly spawned = Promise.resolve()
  stderr = ''
  processTreeUnproven = false
  private exitListeners: ((exit: ProviderProcessExit) => void)[] = []
  private gone = false
  private closing = false
  private lostWith: Error | undefined
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
    return this.gone
  }
  onExit(listener: (exit: ProviderProcessExit) => void): void {
    if (this.gone) {
      listener(FAKE_EXIT)
    } else {
      this.exitListeners.push(listener)
    }
  }
  stderrTail(): string {
    return this.stderr
  }
  pauseReading(): void {
    this.agent.stdout.pause()
  }
  resumeReading(): void {
    this.agent.stdout.resume()
  }
  /** What a close proves once the protocol is closed; replace it to leave the exit unproven. */
  proveClose = async (): Promise<boolean> => {
    this.exit()
    return true
  }
  override close(error?: Error): Promise<boolean> {
    this.closes += 1
    this.closing ||= !this.gone
    this.drainNotifications(error)
    return this.proveClose().finally(() => super.close(error))
  }
  /** The agent process ends on its own (or Orca's close landed). */
  exit(): void {
    if (this.gone) {
      return
    }
    this.gone = true
    const error =
      this.lostWith ?? new AcpConnectionClosedError(this.stderr || `${this.launch.command} exited`)
    super.close(error)
    this.connectionOptions.onExit?.(error, { expected: this.closing, exit: FAKE_EXIT })
    for (const listener of this.exitListeners.splice(0)) {
      listener(FAKE_EXIT)
    }
  }
  private lost(error: Error): void {
    this.lostWith ??= error
    if (this.closing || this.gone) {
      return
    }
    this.connectionOptions.onClose?.(error)
  }
}

const FAKE_EXIT: ProviderProcessExit = { code: 0, signal: null, processless: false }
