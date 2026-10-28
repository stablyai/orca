// Lost stop answers are unverifiable; only confirmed exit or cancellation releases the fence.
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import {
  cancelRemoteOrcadManagedStop,
  completeRemoteOrcadManagedStop
} from './orcad-managed-remote-stop'
import type { OrcadSlotOptions } from '../../ssh/orcad-recovery-slot'
import type {
  OrcadDaemonRetirementVerdict,
  OrcadManagedStopRequest
} from '../../../shared/orcad-stop-request'
import { errorMessage } from '../../../shared/error-message'

type OrcadDecommissionStopSettlement =
  | { state: 'exited'; retirement: OrcadDaemonRetirementVerdict }
  /** Confirmed cancellation leaves the incumbent serving. */
  | { state: 'withdrawn'; verdict: 'live' | 'unverifiable'; reason: string }
  /** Stop underway or unconfirmed; retain the fence. */
  | { state: 'unsettled'; verdict: 'live' | 'unverifiable'; reason: string }

export async function settleOrcadDecommissionStop(
  options: OrcadSlotOptions,
  request: OrcadManagedStopRequest
): Promise<OrcadDecommissionStopSettlement> {
  let verdict: 'live' | 'unverifiable'
  let reason: string
  try {
    const completion = await completeRemoteOrcadManagedStop(options, request)
    if (completion.verdict === 'exited') {
      // A completion without a recorded outcome proves exit but not retirement.
      return { state: 'exited', retirement: completion.retirement ?? 'unverifiable' }
    }
    verdict = completion.verdict
    reason = `orcad ${request.version} did not exit (${completion.verdict}).`
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    verdict = 'unverifiable'
    reason = `The host gave no verifiable stop verdict: ${errorMessage(error)}`
  }
  try {
    const cancellation = await cancelRemoteOrcadManagedStop(options, request)
    if (cancellation.outcome === 'canceled') {
      return {
        state: 'withdrawn',
        verdict,
        reason: `${reason} The stop request was withdrawn; orcad keeps serving.`
      }
    }
    return {
      state: 'unsettled',
      verdict: 'live',
      reason: `${reason} orcad already acted on the request and is still stopping.`
    }
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      state: 'unsettled',
      verdict: 'unverifiable',
      reason: `${reason} Withdrawing the request gave no verifiable answer: ${errorMessage(error)}`
    }
  }
}
