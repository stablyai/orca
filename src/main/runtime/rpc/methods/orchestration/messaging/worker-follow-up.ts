import {
  planSemanticWorkerFollowUp,
  workerFollowUpArguments
} from '../worker/follow-up/worker-follow-up-admission'
/** A message to a worker that finished becomes its next Task: worker-start run for the sender, on that same worker.
 *  Open workers take it in place, closed ones reopen in their saved conversation, and agents that keep none start fresh. */

import { dispatchItemUid } from '../../../../../bots/bot-item-dispatch-facts'
import { resolveItem } from '../../bots-items-write-support'
import { BOT_ITEM_ORIGIN_PREFIX } from '../../bots-items-worker-origin'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { parseWorkerTerminalPriorOwnerIds } from '../../../../orchestration/db/pane-key-match'
import {
  carryWorkerResumeSession,
  resolveWorkerLineage
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type {
  DispatchContextRow,
  MessageType
} from '../../../../orchestration/db/orchestration-records'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import type { RpcContext } from '../../../core'
import { startWorker } from '../worker/worker-start-method'
import {
  chooseWorkerFollowUpPlacement,
  type WorkerFollowUpDelivery
} from '../worker/follow-up/worker-follow-up-choice'

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
  return planSemanticWorkerFollowUp(
    dispatchId,
    db.getDispatchContextById(dispatchId),
    () => resolveWorkerLineage(db, dispatchId),
    type,
    (id) => Boolean(db.getFederatedDispatch(id)),
    (id) => Boolean(db.getWorkerDispatch(id))
  )
}

/** `send --to dispatch:<id> --item <n>`: new work for that item, which only a follow-up can take, so
 *  the item leaves the mail's params; item mail's `--file` never goes with it. */
export function splitForItem<P extends { item?: string; files?: string[] }>(
  to: string,
  params: P
): { forItem: string | undefined; params: P } {
  const forItem = to.startsWith('dispatch:') ? params.item : undefined
  if (forItem === undefined) {
    return { forItem, params }
  }
  if (params.files?.length) {
    throw new OrchestrationError(
      'invalid_argument',
      "--file goes with --to bot:<name> --item <n>. A worker's new work names its files in --body. Nothing was sent.",
      { effectsApplied: false }
    )
  }
  return { forItem, params: { ...params, item: undefined } }
}

/** `send --to dispatch: --item`: only a finished worker's follow-up takes work for an item; a working
 *  worker's report would answer for both. Refused before anything is sent. */
export function assertFollowUpForItem(forItem: string | undefined, followsUp: boolean): void {
  if (forItem !== undefined && !followsUp) {
    throw new OrchestrationError(
      'invalid_argument',
      "--item gives a finished worker on this computer a follow-up for that item, and this one can't take one now: it is still working, runs on another computer, or another send just gave it work. Wait for its report, or start one with `orchestration worker-start --item <n>`. Nothing was sent.",
      { effectsApplied: false }
    )
  }
}

/** A worker on one item, by its start or a link to any of its steps, never takes another's: its
 *  lineage would then speak for both items. */
async function assertSameItem(
  ctx: FollowUpContext,
  db: OrchestrationDb,
  plan: Extract<WorkerFollowUpPlan, { kind: 'start' }>,
  forItem: string
): Promise<void> {
  const store = ctx.runtime.botItems.store()
  const item = await resolveItem(store, forItem)
  // The worker's steps: the addressed one's, its newest one's and those of every earlier owner of its
  // terminal, which a handed-over terminal parts, each read once and at most 200. Their starts settle
  // it without a lookup; else two items linking them are enough to tell.
  const priorOwners = parseWorkerTerminalPriorOwnerIds(
    plan.resource?.prior_owner_dispatch_ids ?? '[]'
  )
  const steps = new Set<string>()
  let elsewhere = false
  for (const start of [plan.addressed, plan.latest.id, ...(priorOwners ?? [])]) {
    for (let id: string | null = start; id && !steps.has(id) && steps.size < 200 && !elsewhere;) {
      steps.add(id)
      elsewhere = (dispatchItemUid(db, id) ?? item.uid) !== item.uid
      id = db.getDispatchContextById(id)?.follow_up_of_dispatch_id ?? null
    }
  }
  elsewhere ||= (await store.itemsLinking('dispatch', [...steps], 2)).some(
    (uid) => uid !== item.uid
  )
  if (elsewhere) {
    throw new OrchestrationError(
      'invalid_argument',
      `This worker has worked for another item, so it can't take work for item ${item.number}. Start one for it with \`orchestration worker-start --item ${item.number}\`. Nothing was sent.`,
      { effectsApplied: false }
    )
  }
}

export async function startWorkerFollowUp(args: {
  ctx: FollowUpContext
  db: OrchestrationDb
  plan: Extract<WorkerFollowUpPlan, { kind: 'start' }>
  from: string
  message: { subject: string; body?: string | undefined }
  /** The Dispatch whose unread mail this follow-up's Task tells it to check. */
  takesMailOf?: string
  /** `send --item <n>`: the follow-up is for that item, kept on its Dispatch as `worker-start --item`. */
  forItem?: string
}): Promise<WorkerFollowUpOutcome> {
  const { ctx, db } = args
  const { latest, resource } = args.plan
  if (args.forItem !== undefined) {
    await assertSameItem(ctx, db, args.plan, args.forItem)
  }
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
        taskTitle: subject,
        ...(args.forItem !== undefined
          ? { origin: `${BOT_ITEM_ORIGIN_PREFIX}${args.forItem}` }
          : {})
      },
      // The send's own receipt is already pending; the follow-up only names what it accepted.
      { ...ctx, orchestrationMutation: undefined },
      {
        ...workerFollowUpArguments(args.plan),
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
        ...(args.takesMailOf ? { takesMailOf: args.takesMailOf } : {})
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
