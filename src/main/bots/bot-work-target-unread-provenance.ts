import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationEntryCaller } from '../runtime/orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { FOLLOW_UP_MESSAGE_TYPES } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-plan'
import { readMessagesWorkTargetProvenance } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import type { WorkerFollowUp } from '../runtime/rpc/methods/orchestration/worker/follow-up/worker-follow-up-placement'
import { activeBotWorkTargetForCaller } from './bot-turn-work-target'
import {
  verifyLocalWorkerDispatchMatchesAllWorkTargets,
  verifyLocalWorkerDispatchMatchesWorkTarget
} from './bot-work-target-follow-up'

export type UnreadWorkTargetProvenanceBatch =
  | { kind: 'empty' }
  | { kind: 'untargeted'; messageCount: number }
  | {
      kind: 'targeted'
      placements: ResolvedBotWorkTargetPlacement[]
      messageCount: number
      targetedCount: number
    }
  | { kind: 'corrupt'; messageId: string; reason: string }

/**
 * Inspect ALL unread follow-up messages across `dispatchId` and its follow-up ancestors so neither
 * earlier untargeted mail nor mixed-origin batches can hide a targeted message's provenance.
 */
export function collectLineageUnreadWorkTargetProvenances(
  db: OrchestrationDb,
  dispatchId: string
): UnreadWorkTargetProvenanceBatch {
  const seen = new Set<string>()
  const queue = [dispatchId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    const parent = db.getDispatchContextById(id)?.follow_up_of_dispatch_id
    if (parent && !seen.has(parent)) {
      queue.push(parent)
    }
  }
  const unreadIds: string[] = []
  for (const id of seen) {
    const unread = db.getUnreadMessages(`dispatch:${id}`, [...FOLLOW_UP_MESSAGE_TYPES])
    for (const msg of unread) {
      unreadIds.push(msg.id)
    }
  }
  if (unreadIds.length === 0) {
    return { kind: 'empty' }
  }
  const byId = readMessagesWorkTargetProvenance(db, unreadIds)
  const placements: ResolvedBotWorkTargetPlacement[] = []
  const seenPlacementKeys = new Set<string>()
  let targetedCount = 0
  for (const id of unreadIds) {
    const entry = byId.get(id)
    if (!entry || entry.kind === 'absent') {
      continue
    }
    if (entry.kind === 'corrupt') {
      return { kind: 'corrupt', messageId: id, reason: entry.reason }
    }
    targetedCount += 1
    const key = JSON.stringify(entry.placement)
    if (!seenPlacementKeys.has(key)) {
      seenPlacementKeys.add(key)
      placements.push(entry.placement)
    }
  }
  if (targetedCount === 0) {
    return { kind: 'untargeted', messageCount: unreadIds.length }
  }
  return {
    kind: 'targeted',
    placements,
    messageCount: unreadIds.length,
    targetedCount
  }
}

/**
 * Resolve and enforce work targets for a worker follow-up before `followUp.place()` can touch
 * terminals or release leftover shells. Only trusted background unread-mail follow-through with
 * real unread SQLite mail uses persisted provenance alone; direct `takesMailOf` cannot bypass.
 */
export async function resolveVerifiedFollowUpWorkTarget(
  runtime: Pick<
    OrcaRuntimeService,
    | 'botWorkTargets'
    | 'showManagedTerminalWorkspace'
    | 'getBotWorkTargetCatalogStore'
    | 'showTerminal'
  >,
  db: OrchestrationDb,
  orchestrationCaller: OrchestrationEntryCaller | undefined,
  followUp: Pick<
    WorkerFollowUp,
    'of' | 'addressed' | 'takesMailOf' | 'trustedUnreadMailFollowThrough'
  >
): Promise<ResolvedBotWorkTargetPlacement | undefined> {
  const activeTurnTarget = activeBotWorkTargetForCaller(runtime.botWorkTargets, orchestrationCaller)
  const unreadBatches = [
    collectLineageUnreadWorkTargetProvenances(db, followUp.of),
    ...(followUp.takesMailOf && followUp.takesMailOf !== followUp.of
      ? [collectLineageUnreadWorkTargetProvenances(db, followUp.takesMailOf)]
      : [])
  ]
  for (const batch of unreadBatches) {
    if (batch.kind === 'corrupt') {
      throw new OrchestrationError(
        'invalid_argument',
        `Unread mail ${batch.messageId} for dispatch:${followUp.addressed} has unreadable work-target provenance (${batch.reason}). No effects were applied.`,
        { effectsApplied: false }
      )
    }
  }
  const persistedTargets = unreadBatches.flatMap((batch) =>
    batch.kind === 'targeted' ? batch.placements : []
  )
  const hasUnreadMail = unreadBatches.some((batch) => batch.kind !== 'empty')
  const isTrustedUnreadFollowThrough =
    Boolean(followUp.takesMailOf && followUp.trustedUnreadMailFollowThrough) && hasUnreadMail
  const requiredTargets = isTrustedUnreadFollowThrough
    ? persistedTargets
    : [...(activeTurnTarget ? [activeTurnTarget] : []), ...persistedTargets]
  if (requiredTargets.length === 0) {
    return undefined
  }
  await verifyLocalWorkerDispatchMatchesAllWorkTargets(runtime, db, followUp.of, requiredTargets)
  return (
    requiredTargets.find((target) => target.expectedWorkspaceInstanceId !== undefined) ??
    requiredTargets.find((target) => target.mode === 'existing') ??
    requiredTargets[0]
  )
}

/** Verify unread follow-through provenance before steering into an already-claimed follow-up. */
export async function verifyUnreadFollowThroughBeforeAction(
  runtime: Pick<
    OrcaRuntimeService,
    'showManagedTerminalWorkspace' | 'getBotWorkTargetCatalogStore' | 'showTerminal'
  >,
  db: OrchestrationDb,
  dispatchId: string,
  steerDispatchId?: string
): Promise<void> {
  const batch = collectLineageUnreadWorkTargetProvenances(db, dispatchId)
  if (batch.kind === 'corrupt') {
    throw new OrchestrationError(
      'invalid_argument',
      `unread mail ${batch.messageId} has unreadable work-target provenance (${batch.reason})`,
      { effectsApplied: false }
    )
  }
  if (steerDispatchId && batch.kind === 'targeted') {
    await verifyLocalWorkerDispatchMatchesAllWorkTargets(
      runtime,
      db,
      steerDispatchId,
      batch.placements
    )
  }
}

export type UnreadMessageTargetPartition = {
  deliverableIds: string[]
  held: { messageId: string; reason: string }[]
}

/**
 * Partition unread messages for transfer into `destinationDispatchId`.
 * Ordinary (untargeted) messages and targeted messages matching the live destination proceed;
 * drifted, mismatched, or corrupt targeted messages stay held in their original mailbox.
 */
export async function partitionUnreadMessagesForWorkerDispatch(
  runtime: Pick<
    OrcaRuntimeService,
    'showManagedTerminalWorkspace' | 'getBotWorkTargetCatalogStore' | 'showTerminal'
  >,
  db: OrchestrationDb,
  destinationDispatchId: string,
  messages: readonly Pick<MessageRow, 'id'>[]
): Promise<UnreadMessageTargetPartition> {
  if (messages.length === 0) {
    return { deliverableIds: [], held: [] }
  }
  const byId = readMessagesWorkTargetProvenance(
    db,
    messages.map((message) => message.id)
  )
  const verificationByKey = new Map<string, { ok: true } | { ok: false; reason: string }>()
  const deliverableIds: string[] = []
  const held: { messageId: string; reason: string }[] = []
  for (const message of messages) {
    const entry = byId.get(message.id)
    if (!entry || entry.kind === 'absent') {
      deliverableIds.push(message.id)
      continue
    }
    if (entry.kind === 'corrupt') {
      held.push({ messageId: message.id, reason: entry.reason })
      continue
    }
    const key = JSON.stringify(entry.placement)
    let verdict = verificationByKey.get(key)
    if (!verdict) {
      try {
        await verifyLocalWorkerDispatchMatchesWorkTarget(
          runtime,
          db,
          destinationDispatchId,
          entry.placement
        )
        verdict = { ok: true }
      } catch (error) {
        verdict = {
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        }
      }
      verificationByKey.set(key, verdict)
    }
    if (verdict.ok) {
      deliverableIds.push(message.id)
    } else {
      held.push({ messageId: message.id, reason: verdict.reason })
    }
  }
  return { deliverableIds, held }
}

/** Query unread current-delivery messages in `sourceMailbox` for `runId` (bounded by optional sequence) and partition them against `destinationDispatchId`. */
export async function verifyUnreadMailboxMessagesForWorkerDispatch(
  runtime: Pick<
    OrcaRuntimeService,
    'showManagedTerminalWorkspace' | 'getBotWorkTargetCatalogStore' | 'showTerminal'
  >,
  db: OrchestrationDb,
  args: {
    destinationDispatchId: string
    sourceMailbox: string
    runId: string
    throughSequence?: number
  }
): Promise<UnreadMessageTargetPartition & { totalCount: number }> {
  const throughClause = args.throughSequence === undefined ? '' : ' AND sequence <= ?'
  const params: (string | number)[] = [args.runId, args.sourceMailbox]
  if (args.throughSequence !== undefined) {
    params.push(args.throughSequence)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of one TEXT primary-key column.
  const rows = db.db
    .prepare(
      `SELECT id FROM messages
       WHERE run_id = ? AND to_handle = ? AND read = 0
         AND delivery_contract = 'current_delivery'${throughClause}
       ORDER BY sequence ASC`
    )
    .all(...params) as { id: string }[]
  const partition = await partitionUnreadMessagesForWorkerDispatch(
    runtime,
    db,
    args.destinationDispatchId,
    rows
  )
  return { ...partition, totalCount: rows.length }
}
