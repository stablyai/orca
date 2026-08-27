import {
  bindCertificationIntentToDispatch,
  claimCertificationIntent,
  releaseCertificationIntentClaim,
  verifyCertificationIntent
} from '../../orchestration/control-plane/certification-intent'
import type { ControlPlaneDatabaseHandle } from '../../orchestration/control-plane/control-plane-store'
import type { RouteIdentity } from '../../orchestration/control-plane/route-registry-types'
import { OrchestrationError } from '../../orchestration/orchestration-error'

/** The runtime side of a first-certification launch.
 *
 *  A certification intent is the only thing that may open a launch on a route
 *  nothing has proven, so every check here is about matching the intent to the
 *  launch ACTUALLY being performed rather than to the caller's description of it.
 */

/** True only when a real, unconsumed intent names exactly this launch. A
 *  mismatch throws rather than quietly declining, so a wrong intent is a loud
 *  error instead of an ordinary uncertified-route rejection. */
export function assertCertificationIntentMatches(args: {
  handle: ControlPlaneDatabaseHandle
  intentId: string | undefined
  runId: string
  outcomeId: string
  taskId: string
  worktreeId: string
  identity: RouteIdentity
  buildId: string
}): boolean {
  if (!args.intentId) {
    return false
  }
  const verdict = verifyCertificationIntent(args.handle, {
    intentId: args.intentId,
    actual: {
      runId: args.runId,
      taskId: args.taskId,
      outcomeId: args.outcomeId,
      worktreeId: args.worktreeId,
      identity: args.identity,
      buildId: args.buildId
    }
  })
  if (!verdict.ok) {
    throw new OrchestrationError('certification_intent_invalid', verdict.reason, {
      code: verdict.code,
      intentId: args.intentId
    })
  }
  return true
}

/** Claims the intent BEFORE the Dispatch exists.
 *
 *  Creating the Dispatch first and consuming second leaves an orphan STARTING
 *  Dispatch behind whenever consumption loses the race. Claiming first means
 *  exactly one concurrent launch wins and the loser is refused while the
 *  database still holds nothing for it. */
function claimCertificationIntentForLaunch(
  handle: ControlPlaneDatabaseHandle,
  args: { intentId: string; claimId: string }
): void {
  const claimed = claimCertificationIntent(handle, {
    intentId: args.intentId,
    claimId: args.claimId,
    nowIso: new Date().toISOString()
  })
  if (!claimed) {
    throw new OrchestrationError(
      'certification_intent_invalid',
      `Certification intent ${args.intentId} was already consumed by another launch.`
    )
  }
}

/** Runs `create` under a certification intent when one was supplied.
 *
 *  The claim is taken BEFORE `create`, so a launch that loses the race is
 *  refused while the database still holds nothing for it and no orphan STARTING
 *  Dispatch is left behind; the claim is returned if `create` produces nothing,
 *  so a failure does not burn the one authorisation. Without an intent this is
 *  just `create()`. */
export function createDispatchUnderCertificationIntent<
  T extends { dispatch: { id: string } }
>(args: {
  handle: ControlPlaneDatabaseHandle
  intentId: string | undefined
  claimId: string
  create: () => T
}): T {
  if (!args.intentId) {
    return args.create()
  }
  claimCertificationIntentForLaunch(args.handle, {
    intentId: args.intentId,
    claimId: args.claimId
  })
  let created: T
  try {
    created = args.create()
  } catch (error) {
    settleCertificationIntentClaim(args.handle, {
      intentId: args.intentId,
      claimId: args.claimId,
      dispatchId: null
    })
    throw error
  }
  settleCertificationIntentClaim(args.handle, {
    intentId: args.intentId,
    claimId: args.claimId,
    dispatchId: created.dispatch.id
  })
  return created
}

function settleCertificationIntentClaim(
  handle: ControlPlaneDatabaseHandle,
  args: { intentId: string; claimId: string; dispatchId: string | null }
): void {
  if (args.dispatchId) {
    bindCertificationIntentToDispatch(handle, {
      intentId: args.intentId,
      dispatchId: args.dispatchId
    })
    return
  }
  // No Dispatch was created, so the one authorisation must not be burned by a
  // failure that produced nothing.
  releaseCertificationIntentClaim(handle, { intentId: args.intentId, claimId: args.claimId })
}
