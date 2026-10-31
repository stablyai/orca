import { selectWorkerFollowUpPlan } from '../../../../orchestration/db/dispatch-context/worker-follow-up-plan'
/** A message to a worker that finished becomes its next Task: worker-start run for the sender, on that same worker.
 *  Open workers take it in place, closed ones reopen in their saved conversation, and agents that keep none start fresh. */

import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  carryWorkerResumeSession,
  resolveWorkerLineage
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { DispatchContextRow, MessageType } from '../../../../orchestration/types'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import type { RpcContext } from '../../../core'
import { startWorker } from '../worker/workers'
import { chooseWorkerFollowUpPlacement } from '../worker/worker-follow-up-choice'

export type WorkerFollowUpPlan =
  | { kind: 'steer'; dispatchId: string }
  | { kind: 'start'; latest: DispatchContextRow; resource: WorkerTerminalResourceRow | undefined }

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
  return selectWorkerFollowUpPlan(
    db.getDispatchContextById(dispatchId),
    () => resolveWorkerLineage(db, dispatchId),
    type,
    (id) => Boolean(db.getFederatedDispatch(id)),
    (id) => Boolean(db.getWorkerDispatch(id))
  )
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
  const placement = await chooseWorkerFollowUpPlacement(ctx.runtime, db, latest, resource)
  const { reopen } = placement
  let freshInstead = false
  const spec = [
    body || subject,
    placement.delivery === 'started_fresh' ? placement.earlierWork : undefined
  ]
    .filter(Boolean)
    .join('\n\n')
  let receipt: unknown
  try {
    receipt = await startWorker(
      {
        from: args.from,
        run: latest.run_id,
        spec,
        taskTitle: subject,
        worktree: `id:${placement.worktreeId}`,
        ...(placement.terminal ? { terminal: placement.terminal } : {}),
        ...(placement.agent ? { agent: placement.agent } : {}),
        ...(placement.model ? { model: placement.model } : {}),
        ...(placement.effort ? { effort: placement.effort } : {})
      },
      // The send's own receipt is already pending; the follow-up only names what it accepted.
      { ...ctx, orchestrationMutation: undefined },
      {
        of: latest.id,
        ...(ctx.orchestrationMutation ? { acceptedBy: ctx.orchestrationMutation } : {}),
        ...(args.consumesMessageIds ? { consumesMessageIds: args.consumesMessageIds } : {}),
        ...(placement.earlierWork ? { earlierWork: placement.earlierWork } : {}),
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
    )
  } catch (error) {
    // A racing send claimed this worker first; this message steers that follow-up.
    if (error instanceof OrchestrationError && error.code === 'follow_up_claimed') {
      return { kind: 'steer', dispatchId: readClaimedDispatchId(error) ?? latest.id }
    }
    throw error
  }
  const started = {
    ...(receipt && typeof receipt === 'object' ? receipt : {}),
    delivery: freshInstead ? 'started_fresh' : placement.delivery,
    followUpOf: latest.id
  }
  if (
    resource &&
    'dispatchId' in started &&
    typeof started.dispatchId === 'string' &&
    reopen &&
    !freshInstead
  ) {
    carryWorkerResumeSession(db, started.dispatchId, resource)
  }
  return { kind: 'started', receipt: started }
}

function readClaimedDispatchId(error: OrchestrationError): string | undefined {
  const data = error.data
  const id =
    typeof data === 'object' && data !== null && 'followUpDispatchId' in data
      ? data.followUpDispatchId
      : undefined
  return typeof id === 'string' ? id : undefined
}
