import {
  AgentSessionPreSpawnError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionAcquisitionExitUnprovenError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  AcpCloseOutcome,
  AcpAgentConnection,
  AcpAgentConnectionOptions
} from './acp-agent-connection'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { withProviderSpawnAbsence } from '../provider-process/provider-executable-missing'

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
  | 'closeOutcome'
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

/** Once exit is proven, name the CLI or folder that the spawn found missing. */
export function tagAcpSpawnAbsence(
  error: unknown,
  connection: AcpStructuredConnection | undefined
): void {
  if (error instanceof Error && connection?.exited) {
    withProviderSpawnAbsence(error, connection.spawnAbsence)
  }
}

/** Local composition preserves failed receipt without losing actual managed acceptance. */
export async function closeAcpAcquisition(connection: AcpStructuredConnection): Promise<boolean> {
  return (await connection.closeOutcome()).accepted
}

export function acpCloseReport(
  connection: AcpStructuredConnection,
  outcome: AcpCloseOutcome,
  cause?: unknown
): Error | undefined {
  if (outcome.receive.state === 'failed') {
    cause =
      cause === undefined || cause === outcome.receive.error
        ? outcome.receive.error
        : new AggregateError(
            [cause, outcome.receive.error],
            cause instanceof Error ? cause.message : String(cause)
          )
  }
  if (outcome.cleanupError !== undefined && outcome.cleanupError !== cause) {
    cause =
      cause === undefined
        ? outcome.cleanupError
        : new AggregateError(
            [cause, outcome.cleanupError],
            cause instanceof Error ? cause.message : String(cause)
          )
  }
  if (!outcome.accepted) {
    return new AgentSessionAcquisitionExitUnprovenError(cause ?? new Error('ACP close unproven'))
  }
  if (connection.exitStatus?.processless) {
    return new AgentSessionPreSpawnError(cause ?? new Error('ACP agent did not start'))
  }
  if (outcome.physical.killDelivered && outcome.physical.root !== 'exited') {
    return new AgentSessionAcquisitionRootExitObservedError(
      cause ?? new Error('ACP writer killed'),
      'kill-delivered'
    )
  }
  if (
    outcome.receive.state === 'failed' ||
    outcome.cleanupError !== undefined ||
    connection.processTreeUnproven
  ) {
    return new AgentSessionAcquisitionRootExitObservedError(
      cause ?? new Error('ACP descendant exit unproven')
    )
  }
  return undefined
}
