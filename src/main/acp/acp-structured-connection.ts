// The ACP agent as the adapter holds it: one connection that owns both the agent's process and its
// protocol (`createAcpAgentConnection`). Supervision, the process-tree teardown, Windows-safe
// spawning and stdio are the connection's; turns, Stop and steering are the adapter's.

import type { AcpAgentConnection, AcpAgentConnectionOptions } from './acp-agent-connection'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'

/** What the adapter uses of a connection; tests stand in a scripted agent behind the same surface. */
export type AcpStructuredConnection = Pick<
  AcpAgentConnection,
  | 'initialize'
  | 'start'
  | 'prompt'
  | 'cancel'
  | 'setConfigOption'
  | 'setModel'
  | 'subscribe'
  | 'closed'
  | 'spawned'
  | 'pid'
  | 'exited'
  | 'stderrTail'
  | 'onExit'
  | 'pauseReading'
  | 'resumeReading'
  | 'close'
  | 'processTreeUnproven'
>

export type ConnectAcpAgent = (
  launch: ProviderProcessLaunch,
  options: AcpAgentConnectionOptions
) => AcpStructuredConnection

/** Resolves once `connection`'s process exits, `signal` aborts, or `ms` pass, whichever is first. */
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
