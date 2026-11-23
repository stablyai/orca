import { errorMessage } from '../../../shared/errors/error-message'
import {
  OrcadPreflightUnansweredError,
  preflightInstalledOrcad
} from '../install/orcad-remote-preflight'

type OrcadCandidatePreflightFailure = {
  // A failed preflight is remembered as host incompatibility; an unanswered one is retried next connect.
  code: 'orcad_candidate_preflight_failed' | 'orcad_candidate_preflight_unanswered'
  failure: string
}

/** Preflight before any stop; asked to, the candidate also names the daemon generations under the served data root. */
export async function preflightOrcadCandidate(
  options: Omit<Parameters<typeof preflightInstalledOrcad>[0], 'probeDaemonsUnder'> & {
    userDataDir: string
  },
  probeDaemons: boolean
): Promise<
  { hostDaemonProtocols: readonly number[] | undefined } | OrcadCandidatePreflightFailure
> {
  try {
    const answer = await preflightInstalledOrcad({
      ...options,
      ...(probeDaemons ? { probeDaemonsUnder: options.userDataDir } : {})
    })
    return { hostDaemonProtocols: answer.liveDaemonProtocols ?? undefined }
  } catch (error) {
    options.signal?.throwIfAborted()
    return {
      code:
        error instanceof OrcadPreflightUnansweredError
          ? 'orcad_candidate_preflight_unanswered'
          : 'orcad_candidate_preflight_failed',
      failure: `Candidate profile preflight failed; the incumbent was not stopped: ${errorMessage(error)}`
    }
  }
}
