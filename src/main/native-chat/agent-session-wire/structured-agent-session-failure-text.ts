// The facts a start or an exit reduces to, and the one place a failed start is worded. The
// sentence itself comes from `agentSessionFailureWords`, beside the fact it states.

import {
  agentSessionFailureFact,
  providerDiagnosticOf,
  type AgentSessionArgumentProblem,
  type SubmissionRejectionFact,
  type AgentSessionFailureKind,
  type ProviderDiagnostic
} from '../../../shared/agent-session-failure'
import type { AgentSessionRefusalReason } from '../../../shared/agent-session-refusal-details'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import {
  agentSessionRefusalReference,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { providerExecutableMissing } from '../../provider-process/provider-executable-missing'
import { argumentProblemOf } from '../structured-agent-arguments-error'

/** Start refusals whose situation is itself what the person reads, with its own next step. */
const TYPED_START_REFUSALS = [
  'notSignedIn',
  'cliMissing',
  'historyTooLarge',
  'managedAccountEnvOverride',
  'accountSwitchInProgress',
  'managedAccountUnsupported',
  'launchFolderMissing',
  'historyInOtherAccount',
  'claudeAccountFolderMissing',
  'claudeAccountSetupFailed',
  'agentCommandNotRunnable'
] as const satisfies readonly (AgentSessionFailureKind &
  AgentSessionRefusalReason<'agent_session_operation_invalid'>)[]

function typedStartRefusal(
  reason: string | undefined
): (typeof TYPED_START_REFUSALS)[number] | undefined {
  return TYPED_START_REFUSALS.find((typed) => typed === reason)
}

/** Marks the error an adapter observed its child's exit with, where it observed it. */
export function withObservedProviderExit<TError extends Error>(error: TError): TError {
  return Object.assign(error, { providerExitObserved: true })
}

/** Whether the adapter saw the child exit on its own. Follows `cause` and the errors a cleanup
 *  aggregated, since the acquisition errors wrap what the adapter threw. */
export function providerExitObserved(error: unknown, depth = 0): boolean {
  if (depth >= 6 || !(error instanceof Error)) {
    return false
  }
  if ('providerExitObserved' in error && error.providerExitObserved === true) {
    return true
  }
  if (
    error instanceof AggregateError &&
    error.errors.some((inner) => providerExitObserved(inner, depth + 1))
  ) {
    return true
  }
  return providerExitObserved(error.cause, depth + 1)
}

/** A start that did not land. A refusal the adapter typed keeps its situation, and an exit the
 *  adapter observed says the provider stopped; anything else blames no one — it may be Orca's, or
 *  a spawn that failed. Either keeps the provider's diagnostic when the error carried one. */
export function providerStartupFailureFact(cause?: unknown): SubmissionRejectionFact {
  const typed = typedStartRefusal(
    cause instanceof AgentSessionAcquisitionRefusal ? cause.reason : undefined
  )
  if (typed) {
    return agentSessionFailureFact(typed, {
      ...(cause instanceof AgentSessionAcquisitionRefusal ? { account: cause.account } : {}),
      detail: providerDiagnosticOf(cause)
    })
  }
  if (providerExecutableMissing(cause)) {
    return agentSessionFailureFact('cliMissing')
  }
  return agentSessionFailureFact(
    providerExitObserved(cause) ? 'providerStartFailed' : 'startFailed',
    { detail: providerDiagnosticOf(cause), argumentProblem: argumentProblemOf(cause) }
  )
}

/** A child that ended before it proved its start: an exit is a start that failed, keeping the
 *  provider's diagnostic; an Orca fault or a typed start refusal stays what it was. */
function startupFailureFromExit(
  failure: SubmissionRejectionFact | undefined
): SubmissionRejectionFact {
  if (!failure || failure.kind === 'providerExited') {
    return agentSessionFailureFact('providerStartFailed', { detail: failure?.detail })
  }
  return failure
}

/** What the chat records when a session could not be made ready. Only a refusal the host typed as
 *  an observed exit says the provider stopped; a verdict of `exited` means only that nothing runs
 *  now. */
function refusedStartFailureFact(
  cause: Extract<StructuredAgentSessionStartFailureCause, { refusal: unknown }>
): SubmissionRejectionFact {
  const { refusal, diagnostic, argumentProblem } = cause
  const reason = refusal.details?.reason
  const typed = typedStartRefusal(reason)
  if (typed) {
    return agentSessionFailureFact(typed, {
      ...(refusal.code === 'agent_session_operation_invalid'
        ? { account: refusal.details?.account }
        : {}),
      detail: diagnostic
    })
  }
  if (reason === 'providerStartFailed') {
    return agentSessionFailureFact('providerStartFailed', { detail: diagnostic })
  }
  return agentSessionFailureFact(cause.newSession ? 'startFailed' : 'restartFailed', {
    detail: diagnostic,
    argumentProblem,
    refusal: agentSessionRefusalReference(refusal)
  })
}

/** Why a start the chat needed did not land, as the place that saw it knows it. */
export type StructuredAgentSessionStartFailureCause =
  /** The session could not be made ready; the provider's words, if any, are kept host-side, off
   *  the refusal. `newSession`: one that never ran, so it failed to start rather than restart. */
  | {
      refusal: AgentSessionWireRefusal
      diagnostic?: ProviderDiagnostic
      argumentProblem?: AgentSessionArgumentProblem
      newSession?: true
    }
  /** A start that threw, or an adapter's own startup failure; any diagnostic it carries. */
  | { error: unknown }
  /** The child ended before it proved its start, as its ended event told it. */
  | { exit: SubmissionRejectionFact | undefined }
  /** The provider exited while starting; only its words are known, and the caller names their
   *  audience. */
  | { diagnostic: ProviderDiagnostic | undefined }
  /** Orca's own fault; its error belongs in the log. */
  | { hostFault: true }
  /** Already typed where it was observed. */
  | { failure: SubmissionRejectionFact }

/** A start failure's row repeats the sentence its rejected messages carry: both are about the
 *  messages the start was for. */
export type StructuredAgentSessionStartFailureWords = AgentJournalDispatchRejection

/** The fact a failed start records, for a writer that words it on its own surface. */
export function structuredAgentSessionStartFailureFact(
  cause: StructuredAgentSessionStartFailureCause
): SubmissionRejectionFact {
  if ('refusal' in cause) {
    return refusedStartFailureFact(cause)
  }
  if ('error' in cause) {
    return providerStartupFailureFact(cause.error)
  }
  if ('exit' in cause) {
    return startupFailureFromExit(cause.exit)
  }
  if ('diagnostic' in cause) {
    return agentSessionFailureFact('providerStartFailed', { detail: cause.diagnostic })
  }
  if ('hostFault' in cause) {
    return agentSessionFailureFact('hostFault')
  }
  return cause.failure
}

/** The one place a failed start is worded: the error row and every message it rejects carry this
 *  sentence and this fact, whichever writer saw the start fail. */
export function structuredAgentSessionStartFailure(
  cause: StructuredAgentSessionStartFailureCause,
  context: AgentSessionFailureWordsContext = {}
): StructuredAgentSessionStartFailureWords {
  return agentSessionFailureWords(structuredAgentSessionStartFailureFact(cause), {
    ...context,
    ...('refusal' in cause && cause.newSession ? { messageSubmitted: false } : {}),
    surface: 'rejection'
  })
}
