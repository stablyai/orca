import type { JsonlRpcCloseOutcome } from '../jsonl-rpc/agent-connection'
import {
  agentSessionFailureFact,
  providerDiagnostic,
  providerDiagnosticOf,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import {
  providerSpawnAbsent,
  withProviderSpawnAbsence
} from '../provider-process/provider-executable-missing'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { PiRpcConnection } from './rpc-session'

/** How an unexpected Pi exit reads; a Pi that never ran names its missing CLI or folder. */
export function piExitFailure(error: Error, cause: Error): SubmissionRejectionFact {
  if (providerSpawnAbsent(error)) {
    return providerStartupFailureFact(error)
  }
  return agentSessionFailureFact('providerExited', {
    detail:
      providerDiagnosticOf(cause) ??
      providerDiagnosticOf(error) ??
      (cause instanceof JsonlRpcResponseError
        ? providerDiagnostic(cause.message, 'person')
        : undefined)
  })
}

/** What a failed Pi start throws once its close settled; null while the root's exit is unproven. */
export function piStartExitError(
  error: unknown,
  connection: Pick<PiRpcConnection, 'processless' | 'spawnAbsence'>,
  result: Awaited<ReturnType<PiRpcConnection['close']>> | null
): Error | null {
  if (result?.killDelivered && result.root !== 'exited') {
    return new AgentSessionAcquisitionRootExitObservedError(error, 'kill-delivered')
  }
  if (result?.root !== 'exited') {
    return null
  }
  // The start's own error may predate the exit report that proved the CLI or folder missing.
  const cause = withProviderSpawnAbsence(
    error instanceof Error ? error : new Error(String(error)),
    connection.spawnAbsence
  )
  return connection.processless
    ? new AgentSessionAcquisitionExitProvenError(cause)
    : new AgentSessionAcquisitionRootExitObservedError(cause)
}

export function piCloseReport(outcome: JsonlRpcCloseOutcome, cause?: unknown): Error | undefined {
  for (const failure of [
    ...(outcome.receive.state === 'failed' ? [outcome.receive.error] : []),
    ...(outcome.cleanupError === undefined ? [] : [outcome.cleanupError])
  ]) {
    cause =
      cause === undefined || cause === failure
        ? failure
        : new AggregateError(
            [cause, failure],
            cause instanceof Error ? cause.message : String(cause)
          )
  }
  if (!outcome.accepted) {
    return new AgentSessionAcquisitionExitUnprovenError(cause ?? new Error('Pi close unproven'))
  }
  if (
    cause !== undefined ||
    outcome.physical.root !== 'exited' ||
    outcome.physical.tree !== 'exited'
  ) {
    return (
      piStartExitError(
        cause ?? new Error('Pi descendant exit unproven'),
        outcome,
        outcome.physical
      ) ?? undefined
    )
  }
  return undefined
}
