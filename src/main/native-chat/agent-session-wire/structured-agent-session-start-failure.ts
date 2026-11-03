// The adapter that holds the protocol connection decides whether a failed start may run again;
// the host reads only this verdict, never provider error classes.

import type { SubmissionRejectionFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { findInErrorChain } from '../../provider-process/provider-error-chain'
import {
  providerExecutableMissing,
  providerLaunchFolderMissing
} from '../../provider-process/provider-executable-missing'
import { providerRequestTimeoutOf } from '../../provider-process/provider-request-timeout'
import { argumentProblemOf } from '../structured-agent-arguments-error'
import { agentCliInstallationProblemOf } from '../agent-cli-installation-error'
import {
  AgentSessionAcquisitionRefusal,
  isAgentSessionPreSpawnError
} from './structured-agent-session-adapter-errors'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from './structured-agent-session-acquisition-errors'
import {
  providerExitObserved,
  providerStartupFailureFact,
  withObservedProviderExit
} from './structured-agent-session-failure-text'

/** `safe`: the agent gave no answer before its output ended, or declared its answer temporary. */
export type AgentSessionStartRetry = 'safe' | 'never'

/** An adapter's reading of one error in the chain: the agent's answer, final or declared
 *  temporary, or its own transport ending with no answer once output drained. */
export type AgentSessionStartAnswer = (cause: Error) => 'final' | 'temporary' | 'exited' | undefined

export class AgentSessionStartFailure extends Error {
  readonly fact: SubmissionRejectionFact

  constructor(
    cause: unknown,
    readonly retry: AgentSessionStartRetry,
    fact?: SubmissionRejectionFact
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionStartFailure'
    this.fact = fact ?? providerStartupFailureFact(cause)
  }
}

/** `exited`: the adapter saw its process end on its own, which words even a final answer as the
 *  agent's own failure to start without changing whether it may run again. */
export function agentSessionStartFailure(
  error: unknown,
  answer?: AgentSessionStartAnswer,
  exited = false
): AgentSessionStartFailure {
  if (error instanceof AgentSessionStartFailure) {
    return error
  }
  const disposition = startDisposition(error, answer)
  // An adapter's own exit error words the start as the agent's failure, as an observed exit does.
  const worded =
    (exited || disposition.exited) && error instanceof Error
      ? withObservedProviderExit(new Error(error.message, { cause: error }))
      : error
  return new AgentSessionStartFailure(error, disposition.retry, providerStartupFailureFact(worded))
}

/** The adapter's verdict on an error where it read an answer or its own exit; otherwise none. */
export function agentSessionStartVerdict(
  error: unknown,
  answer: AgentSessionStartAnswer
): AgentSessionStartFailure | undefined {
  if (error instanceof AgentSessionStartFailure) {
    return error
  }
  const answered = findInErrorChain(error, (cause) =>
    answer(cause) === undefined ? undefined : true
  )
  return answered ? agentSessionStartFailure(error, answer) : undefined
}

/** Acquisition failures keep at their top the exit proofs and refusals lease bookkeeping reads;
 *  the adapter's verdict goes beneath them, so a final answer outlives its cleanup's proof. */
export function agentSessionAcquireFailure(
  error: unknown,
  answer: AgentSessionStartAnswer
): unknown {
  if (
    error instanceof AgentSessionAcquisitionRootExitObservedError ||
    error instanceof AgentSessionAcquisitionExitProvenError
  ) {
    const verdict = agentSessionStartVerdict(error.cause, answer)
    if (!verdict || verdict === error.cause) {
      return error
    }
    return error instanceof AgentSessionAcquisitionRootExitObservedError
      ? new AgentSessionAcquisitionRootExitObservedError(verdict, error.deathEvidenceKind)
      : new AgentSessionAcquisitionExitProvenError(verdict)
  }
  if (
    error instanceof AgentSessionAcquisitionExitUnprovenError ||
    error instanceof AgentSessionAcquisitionRefusal ||
    isAgentSessionPreSpawnError(error)
  ) {
    return error
  }
  return agentSessionStartVerdict(error, answer) ?? error
}

/** Each session's latest acquisition that ended before the host committed it ready, with the
 *  adapter's verdict; the session's next acquisition or the adapter's close disposes it. */
export class AgentSessionStartEndings {
  private readonly endings = new Map<
    string,
    { generation: string; failure: AgentSessionStartFailure }
  >()

  /** The first ending of an acquisition is its verdict; later reports of it change nothing. */
  record(sessionId: string, generation: string, failure: AgentSessionStartFailure): void {
    if (this.endings.get(sessionId)?.generation !== generation) {
      this.endings.set(sessionId, { generation, failure })
    }
  }

  get(sessionId: string, generation: string): AgentSessionStartFailure | undefined {
    const ended = this.endings.get(sessionId)
    return ended?.generation === generation ? ended.failure : undefined
  }

  forget(sessionId: string): void {
    this.endings.delete(sessionId)
  }

  clear(): void {
    this.endings.clear()
  }
}

/** The verdict for an error no adapter converted, such as an acquisition the host wrapped. */
export function agentSessionStartRetry(error: unknown): AgentSessionStartRetry {
  return error instanceof AgentSessionStartFailure ? error.retry : startDisposition(error).retry
}

/** A failed acquisition replays only once its exit is proven and the adapter's verdict allows it. */
export function retryableAgentSessionAcquisition(error: unknown): boolean {
  return (
    (error instanceof AgentSessionAcquisitionExitProvenError ||
      error instanceof AgentSessionAcquisitionRootExitObservedError) &&
    agentSessionStartRetry(error) === 'safe'
  )
}

/** A final answer anywhere in the chain wins. Cleanup's exit proof alone says nothing about the
 *  agent's answer, so only the agent's own exit, a declared temporary answer or a launch short of
 *  host resources permits one more run. */
function startDisposition(
  error: unknown,
  answer?: AgentSessionStartAnswer
): { retry: AgentSessionStartRetry; exited: boolean } {
  if (
    providerRequestTimeoutOf(error) ||
    argumentProblemOf(error) ||
    agentCliInstallationProblemOf(error) ||
    providerExecutableMissing(error) ||
    providerLaunchFolderMissing(error) ||
    findInErrorChain(error, (cause) =>
      cause instanceof AggregateError ||
      cause instanceof AgentSessionAcquisitionExitUnprovenError ||
      cause instanceof AgentSessionAcquisitionRefusal ||
      isAgentSessionPreSpawnError(cause)
        ? true
        : undefined
    )
  ) {
    return { retry: 'never', exited: false }
  }
  const answers = new Set<ReturnType<AgentSessionStartAnswer> | AgentSessionStartRetry>()
  findInErrorChain(error, (cause) => {
    answers.add(cause instanceof AgentSessionStartFailure ? cause.retry : answer?.(cause))
    // An adapter's verdict already covers the errors beneath it.
    return cause instanceof AgentSessionStartFailure ? true : undefined
  })
  if (answers.has('never') || answers.has('final')) {
    return { retry: 'never', exited: false }
  }
  const exited = answers.has('exited')
  const safe =
    exited ||
    answers.has('safe') ||
    answers.has('temporary') ||
    providerExitObserved(error) ||
    providerResourcePressure(error)
  return { retry: safe ? 'safe' : 'never', exited }
}

/** The host ran short of processes or files; the same launch can run once that passes. */
export function providerResourcePressure(error: unknown): boolean {
  return (
    findInErrorChain(error, (cause) =>
      'code' in cause && ['EAGAIN', 'EMFILE', 'ENFILE'].some((code) => code === cause.code)
        ? true
        : undefined
    ) === true
  )
}
