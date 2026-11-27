import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationEntryCaller } from '../runtime/orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { FOLLOW_UP_MESSAGE_TYPES } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-plan'
import { readMessagesWorkTargetProvenance } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import type { WorkerFollowUp } from '../runtime/rpc/methods/orchestration/worker/follow-up/worker-follow-up-placement'
import { activeBotWorkTargetForCaller } from './bot-turn-work-target'
import { verifyLocalWorkerDispatchMatchesWorkTarget } from './bot-work-target-follow-up'
import { partitionUnreadMessagesForWorkerDispatch } from './bot-work-target-unread-partition'

export {
  partitionUnreadMessagesForBareRecipient,
  partitionUnreadMessagesForResolvedWorkspace,
  partitionUnreadMessagesForWorkerDispatch,
  verifyUnreadMailboxMessagesForWorkerDispatch,
  type UnreadMessageTargetPartition,
  type UnreadMessageTargetPartitionResult
} from './bot-work-target-unread-partition'

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

function collectLineageUnreadFollowUpIds(db: OrchestrationDb, dispatchId: string): string[] {
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
    for (const msg of db.getUnreadMessages(`dispatch:${id}`, [...FOLLOW_UP_MESSAGE_TYPES])) {
      unreadIds.push(msg.id)
    }
  }
  return unreadIds
}

/**
 * Inspect ALL unread follow-up messages across `dispatchId` and its follow-up ancestors so neither
 * earlier untargeted mail nor mixed-origin batches can hide a targeted message's provenance.
 */
export function collectLineageUnreadWorkTargetProvenances(
  db: OrchestrationDb,
  dispatchId: string
): UnreadWorkTargetProvenanceBatch {
  const unreadIds = collectLineageUnreadFollowUpIds(db, dispatchId)
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

function strongestPlacement(
  placements: readonly ResolvedBotWorkTargetPlacement[]
): ResolvedBotWorkTargetPlacement | undefined {
  return (
    placements.find((target) => target.expectedWorkspaceInstanceId !== undefined) ??
    placements.find((target) => target.mode === 'existing') ??
    placements[0]
  )
}

/**
 * Resolve and enforce work targets for a worker follow-up before `followUp.place()` can touch
 * terminals or release leftover shells. Only trusted background unread-mail follow-through with
 * real unread SQLite mail uses persisted provenance alone; direct `takesMailOf` cannot bypass.
 * Invalid targeted mail never blocks unrelated ordinary or valid targeted mail from continuing.
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
  const unreadIds = [
    ...new Set([
      ...collectLineageUnreadFollowUpIds(db, followUp.of),
      ...(followUp.takesMailOf && followUp.takesMailOf !== followUp.of
        ? collectLineageUnreadFollowUpIds(db, followUp.takesMailOf)
        : [])
    ])
  ]
  const isTrustedUnreadFollowThrough =
    Boolean(followUp.takesMailOf && followUp.trustedUnreadMailFollowThrough) && unreadIds.length > 0

  const verifiedTargets: ResolvedBotWorkTargetPlacement[] = []
  if (!isTrustedUnreadFollowThrough && activeTurnTarget) {
    await verifyLocalWorkerDispatchMatchesWorkTarget(runtime, db, followUp.of, activeTurnTarget)
    verifiedTargets.push(activeTurnTarget)
  }

  if ((isTrustedUnreadFollowThrough || followUp.takesMailOf) && unreadIds.length > 0) {
    const partition = await partitionUnreadMessagesForWorkerDispatch(
      runtime,
      db,
      followUp.of,
      unreadIds.map((id) => ({ id }))
    )
    if (partition.deliverableIds.length === 0 && partition.held.length > 0) {
      throw new OrchestrationError('invalid_argument', partition.held[0]!.reason, {
        effectsApplied: false
      })
    }
    verifiedTargets.push(...partition.verifiedPlacements)
  }
  return strongestPlacement(verifiedTargets)
}
