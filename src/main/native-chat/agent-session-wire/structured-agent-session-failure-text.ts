import {
  agentSessionFailureFact,
  providerDiagnostic,
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
import {
  AgentSessionAcquisitionRefusal,
  isAgentSessionPreSpawnError
} from './structured-agent-session-adapter'
import {
  providerExecutableMissing,
  providerLaunchFolderMissing
} from '../../provider-process/provider-executable-missing'
import { providerRequestTimeoutOf } from '../../provider-process/provider-request-timeout'
import { findInErrorChain } from '../../provider-process/provider-error-chain'
import { argumentProblemOf } from '../structured-agent-arguments-error'
import { agentCliInstallationProblemOf } from '../agent-cli-installation-error'
import { agentCliInstallationFacts } from '../../../shared/agent-cli-installation-problem'

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
  'agentCommandNotRunnable',
  'runtimeNotInstalled',
  'providerResumeUnavailable',
  'fullAccessAsRoot',
  'launchPreparationFailed',
  'conversationOpenInTerminal',
  'conversationOpenElsewhere'
] as const satisfies readonly (AgentSessionFailureKind &
  AgentSessionRefusalReason<'agent_session_operation_invalid'>)[]

function typedStartRefusal(
  reason: string | undefined
): (typeof TYPED_START_REFUSALS)[number] | undefined {
  return TYPED_START_REFUSALS.find((typed) => typed === reason)
}

/** A failed launch preparation shows the host error behind it in Details; named problems keep their own words. */
export function launchPreparationDiagnosticOf(error: unknown): ProviderDiagnostic | undefined {
  const preSpawn = findInErrorChain(error, (inner) =>
    isAgentSessionPreSpawnError(inner) && inner.reason === 'launchPreparationFailed'
      ? inner
      : undefined
  )
  if (
    !preSpawn ||
    providerDiagnosticOf(error) ||
    argumentProblemOf(error) ||
    agentCliInstallationProblemOf(error)
  ) {
    return undefined
  }
  // Bounded like the other cause-chain readers, so a cyclic cause cannot hang the host.
  let root: Error = preSpawn
  for (let depth = 0; depth < 6 && root.cause instanceof Error; depth += 1) {
    root = root.cause
  }
  return providerDiagnostic(root.message, 'log')
}

/** The words Details shows for a failed start: the provider's, else the host error behind it. */
export function startFailureDiagnosticOf(error: unknown): ProviderDiagnostic | undefined {
  return providerDiagnosticOf(error) ?? launchPreparationDiagnosticOf(error)
}

/** Mark exit evidence at the adapter’s observation site. */
export function withObservedProviderExit<TError extends Error>(error: TError): TError {
  return Object.assign(error, { providerExitObserved: true })
}

export function providerExitObserved(error: unknown): boolean {
  return (
    findInErrorChain(error, (inner) =>
      'providerExitObserved' in inner && inner.providerExitObserved === true ? true : undefined
    ) ?? false
  )
}

/** Cleanup wrappers retain the provider's typed refusal without changing their exit proof. */
export function startupAcquisitionRefusal(
  error: unknown,
  depth = 0
): AgentSessionAcquisitionRefusal | undefined {
  if (depth >= 6 || !(error instanceof Error)) {
    return undefined
  }
  if (error instanceof AgentSessionAcquisitionRefusal) {
    return error
  }
  return (
    startupAcquisitionRefusal(error.cause, depth + 1) ??
    (error instanceof AggregateError
      ? error.errors.map((inner) => startupAcquisitionRefusal(inner, depth + 1)).find(Boolean)
      : undefined)
  )
}

/** A failed start keeps its typed refusal or observed exit, and the provider diagnostic its Details show. */
export function providerStartupFailureFact(cause?: unknown): SubmissionRejectionFact {
  cause = startupAcquisitionRefusal(cause) ?? cause
  const installation = agentCliInstallationProblemOf(cause)
  if (installation) {
    return agentSessionFailureFact('startFailed', {
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'attachFailed', ...agentCliInstallationFacts(installation) }
      }
    })
  }
  const typed = typedStartRefusal(
    cause instanceof AgentSessionAcquisitionRefusal || isAgentSessionPreSpawnError(cause)
      ? cause.reason
      : undefined
  )
  if (typed) {
    return agentSessionFailureFact(typed, {
      ...(cause instanceof AgentSessionAcquisitionRefusal ? { account: cause.account } : {}),
      detail:
        typed === 'launchPreparationFailed'
          ? (launchPreparationDiagnosticOf(cause) ?? providerDiagnosticOf(cause))
          : providerDiagnosticOf(cause)
    })
  }
  if (providerExecutableMissing(cause)) {
    return agentSessionFailureFact('cliMissing')
  }
  if (providerLaunchFolderMissing(cause)) {
    return agentSessionFailureFact('launchFolderMissing')
  }
  const preparation = launchPreparationDiagnosticOf(cause)
  if (preparation) {
    return agentSessionFailureFact('launchPreparationFailed', { detail: preparation })
  }
  const exited = providerExitObserved(cause)
  return agentSessionFailureFact(exited ? 'providerStartFailed' : 'startFailed', {
    detail: providerDiagnosticOf(cause),
    argumentProblem: argumentProblemOf(cause),
    ...(exited ? {} : { requestTimeout: providerRequestTimeoutOf(cause) })
  })
}

/** Startup exits become start failures; preserve host faults and typed refusals. */
function startupFailureFromExit(
  failure: SubmissionRejectionFact | undefined
): SubmissionRejectionFact {
  if (!failure || failure.kind === 'providerExited') {
    return agentSessionFailureFact('providerStartFailed', { detail: failure?.detail })
  }
  return failure
}

/** Only observed exits blame the provider; an exited owner verdict proves absence alone. */
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

export type StructuredAgentSessionStartFailureCause =
  /** Provider words reach Details, never the sentence; newSession distinguishes first launch from restart. */
  | {
      refusal: AgentSessionWireRefusal
      diagnostic?: ProviderDiagnostic
      argumentProblem?: AgentSessionArgumentProblem
      newSession?: true
    }
  | { error: unknown }
  | { exit: SubmissionRejectionFact | undefined }
  /** Caller assigns the audience of provider startup-exit diagnostics. */
  | { diagnostic: ProviderDiagnostic | undefined }
  /** Host errors stay in logs. */
  | { hostFault: true }
  | { failure: SubmissionRejectionFact }

/** Failure rows and rejected sends share one sentence/fact. */
export type StructuredAgentSessionStartFailureWords = AgentJournalDispatchRejection

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

/** Word each start failure once for its row and every rejected send. */
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
