/** A message to a worker that finished becomes its next Task: worker-start run for the sender, on that same worker.
 *  Open workers take it in place, closed ones reopen in their saved conversation, and agents that keep none start fresh. */

import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  carryWorkerResumeSession,
  FOLLOW_UP_MESSAGE_TYPES,
  resolveWorkerLineage
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { DispatchContextRow, MessageType } from '../../../../orchestration/types'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import type { RpcContext } from '../../../core'
import { startWorker } from '../worker/workers'
import {
  chooseWorkerFollowUpPlacement,
  type WorkerFollowUpDelivery
} from '../worker/worker-follow-up-choice'

const ACTIVE_STATUSES: readonly string[] = ['pending', 'dispatched']

export type WorkerFollowUpPlan =
  | { kind: 'steer'; dispatchId: string }
  | {
      kind: 'start'
      addressed: string
      latest: DispatchContextRow
      resource: WorkerTerminalResourceRow | undefined
    }

export type WorkerFollowUpOutcome =
  | { kind: 'steer'; dispatchId: string }
  | { kind: 'started'; receipt: Record<string, unknown> }

export type FollowUpContext = Pick<
  RpcContext,
  'runtime' | 'orchestrationCompatibilityEvidence' | 'orchestrationCaller' | 'orchestrationMutation'
>

/** Synchronous, so a send to a working worker is admitted as mail before anything can settle it.
 *  Undefined: the mail path decides (a working worker, lifecycle types, paired servers, no worker-start). */
export function planWorkerFollowUp(
  db: OrchestrationDb,
  dispatchId: string,
  type: MessageType
): WorkerFollowUpPlan | undefined {
  const addressed = db.getDispatchContextById(dispatchId)
  // A working worker reads its mail; only a settled Dispatch can have been continued.
  const lineage =
    addressed && !ACTIVE_STATUSES.includes(addressed.status)
      ? resolveWorkerLineage(db, addressed.id)
      : undefined
  if (!lineage) {
    return undefined
  }
  const { latest, resource } = lineage
  if (ACTIVE_STATUSES.includes(latest.status)) {
    return { kind: 'steer', dispatchId: latest.id }
  }
  if (
    !FOLLOW_UP_MESSAGE_TYPES.some((followUpType) => followUpType === type) ||
    db.getFederatedDispatch(latest.id) ||
    !db.getWorkerDispatch(resource?.origin_dispatch_id ?? latest.id)
  ) {
    return latest.id === dispatchId ? undefined : { kind: 'steer', dispatchId: latest.id }
  }
  return { kind: 'start', addressed: dispatchId, latest, resource }
}

export async function startWorkerFollowUp(args: {
  ctx: FollowUpContext
  db: OrchestrationDb
  plan: Extract<WorkerFollowUpPlan, { kind: 'start' }>
  from: string
  message: { subject: string; body?: string | undefined }
  /** Unread mail this follow-up carries, read in the same claim. */
  consumesMessageIds?: readonly string[]
}): Promise<WorkerFollowUpOutcome> {
  const { ctx, db } = args
  const { latest, resource } = args.plan
  const { subject, body } = args.message
  let delivery: WorkerFollowUpDelivery = 'follow_up'
  let reopening = false
  let freshInstead = false
  let releasedShellOf: string | undefined
  let receipt: unknown
  try {
    receipt = await startWorker(
      {
        from: args.from,
        run: latest.run_id,
        spec: body || subject,
        taskTitle: subject
      },
      // The send's own receipt is already pending; the follow-up only names what it accepted.
      { ...ctx, orchestrationMutation: undefined },
      {
        of: latest.id,
        addressed: args.plan.addressed,
        ...(resource ? { custodian: resource.owner_dispatch_id } : {}),
        place: async (assertCreatorCurrent) => {
          const placement = await chooseWorkerFollowUpPlacement(ctx.runtime, db, latest, resource, {
            admit: assertCreatorCurrent,
            requested: (dispatchId) => {
              releasedShellOf = dispatchId
            }
          })
          delivery = placement.delivery
          const { reopen } = placement
          reopening = Boolean(reopen)
          return {
            ...placement,
            ...(reopen
              ? {
                  reopen: async (dispatchId: string) => {
                    const reopened = await reopen(dispatchId)
                    freshInstead = reopened === null
                    return reopened
                  }
                }
              : {})
          }
        },
        ...(ctx.orchestrationMutation ? { acceptedBy: ctx.orchestrationMutation } : {}),
        ...(args.consumesMessageIds ? { consumesMessageIds: args.consumesMessageIds } : {})
      }
    )
  } catch (error) {
    // A racing send claimed this worker first; this message steers that follow-up.
    if (error instanceof OrchestrationError && error.code === 'follow_up_claimed') {
      return { kind: 'steer', dispatchId: readClaimedDispatchId(error) ?? latest.id }
    }
    throw releasedShellOf ? afterShellRelease(error, releasedShellOf) : error
  }
  const started = {
    ...(receipt && typeof receipt === 'object' ? receipt : {}),
    delivery: freshInstead ? 'started_fresh' : delivery,
    followUpOf: latest.id
  }
  if (
    resource &&
    'dispatchId' in started &&
    typeof started.dispatchId === 'string' &&
    reopening &&
    !freshInstead
  ) {
    carryWorkerResumeSession(db, started.dispatchId, resource)
  }
  return { kind: 'started', receipt: started }
}

/** Closing the leftover shell was requested before this refusal and stays requested, so the refusal keeps its cause but not its claim that nothing happened. */
function afterShellRelease(error: unknown, dispatchId: string): unknown {
  if (!(error instanceof OrchestrationError)) {
    return error
  }
  const { data } = error
  if (
    typeof data !== 'object' ||
    data === null ||
    !('effectsApplied' in data) ||
    data.effectsApplied !== false
  ) {
    return error
  }
  // Refusals that claim no effects end with a "No ... effects were applied." sentence; that sentence is what goes.
  return new OrchestrationError(
    error.code,
    `${error.message.replace(/\s*No [^.]*effects were applied\.$/, '')} The follow-up did not start, but Orca had already asked to close the shell Dispatch ${dispatchId}'s finished agent left behind.`,
    { ...data, effectsApplied: true }
  )
}

function readClaimedDispatchId(error: OrchestrationError): string | undefined {
  const data = error.data
  const id =
    typeof data === 'object' && data !== null && 'followUpDispatchId' in data
      ? data.followUpDispatchId
      : undefined
  return typeof id === 'string' ? id : undefined
}
