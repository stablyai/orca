import type { AcpAgentConnection, AcpAgentConnectionOptions } from './acp-agent-connection'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'

export type AcpStructuredConnection = Pick<
  AcpAgentConnection,
  | 'initialize'
  | 'forkSession'
  | 'start'
  | 'prompt'
  | 'cancel'
  | 'setConfigOption'
  | 'setModel'
  | 'requestExtension'
  | 'subscribe'
  | 'closed'
  | 'spawned'
  | 'pid'
  | 'exited'
  | 'spawnAbsence'
  | 'stderrTail'
  | 'exitStatus'
  | 'onExit'
  | 'pauseReading'
  | 'resumeReading'
  | 'close'
  | 'processTreeUnproven'
> & { readonly lastCloseResult?: AcpAgentConnection['lastCloseResult'] }

export type ConnectAcpAgent<Connection = AcpStructuredConnection> = (
  launch: ProviderProcessLaunch,
  options: AcpAgentConnectionOptions
) => Connection

/** Waits for process exit, abort or timeout. */
export function waitForAcpExit(
  connection: AcpStructuredConnection,
  ms: number,
  signal: AbortSignal
): Promise<void> {
  if (connection.exited || signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    connection.onExit(done)
  })
}
