import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readMessagesWorkTargetProvenance } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import {
  type BotWorkTargetWorkspaceRuntime,
  verifyBareRecipientMatchesWorkTarget,
  verifyLocalWorkerDispatchMatchesWorkTarget,
  verifyLocalWorkspaceMatchesWorkTarget
} from './bot-work-target-follow-up'

export type UnreadMessageTargetPartitionResult = {
  deliverableIds: string[]
  ordinaryIds: string[]
  verifiedTargetedIds: string[]
  verifiedPlacements: ResolvedBotWorkTargetPlacement[]
  held: { messageId: string; reason: string }[]
}

export type UnreadMessageTargetPartition = UnreadMessageTargetPartitionResult & {
  /** Re-validate every verified targeted message synchronously against live catalog/registration state. */
  reverifySync: () => UnreadMessageTargetPartitionResult
}

type PlacementVerdict =
  | { ok: true; placement: ResolvedBotWorkTargetPlacement; reverifySync: () => void }
  | { ok: false; reason: string }

type PartitionEntry =
  | { kind: 'ordinary'; messageId: string }
  | { kind: 'held'; messageId: string; reason: string }
  | { kind: 'targeted'; messageId: string; key: string; verdict: PlacementVerdict }

function evaluatePartitionEntries(
  entries: readonly PartitionEntry[],
  runSyncCheck: boolean
): UnreadMessageTargetPartitionResult {
  const syncVerdictByKey = new Map<string, { ok: true } | { ok: false; reason: string }>()
  const deliverableIds: string[] = []
  const ordinaryIds: string[] = []
  const verifiedTargetedIds: string[] = []
  const verifiedPlacements: ResolvedBotWorkTargetPlacement[] = []
  const seenPlacements = new Set<string>()
  const held: { messageId: string; reason: string }[] = []

  for (const item of entries) {
    if (item.kind === 'ordinary') {
      deliverableIds.push(item.messageId)
      ordinaryIds.push(item.messageId)
      continue
    }
    if (item.kind === 'held') {
      held.push({ messageId: item.messageId, reason: item.reason })
      continue
    }
    if (!item.verdict.ok) {
      held.push({ messageId: item.messageId, reason: item.verdict.reason })
      continue
    }
    let ok = true
    let failReason = ''
    if (runSyncCheck) {
      let cached = syncVerdictByKey.get(item.key)
      if (!cached) {
        try {
          item.verdict.reverifySync()
          cached = { ok: true }
        } catch (error) {
          cached = { ok: false, reason: error instanceof Error ? error.message : String(error) }
        }
        syncVerdictByKey.set(item.key, cached)
      }
      ok = cached.ok
      if (!cached.ok) {
        failReason = cached.reason
      }
    }
    if (ok) {
      deliverableIds.push(item.messageId)
      verifiedTargetedIds.push(item.messageId)
      if (!seenPlacements.has(item.key)) {
        seenPlacements.add(item.key)
        verifiedPlacements.push(item.verdict.placement)
      }
    } else {
      held.push({ messageId: item.messageId, reason: failReason })
    }
  }
  return { deliverableIds, ordinaryIds, verifiedTargetedIds, verifiedPlacements, held }
}

async function partitionMessagesWithVerifier(
  db: OrchestrationDb,
  messages: readonly Pick<MessageRow, 'id'>[],
  verifyPlacement: (
    placement: ResolvedBotWorkTargetPlacement
  ) => Promise<{ reverifySync: () => void }>
): Promise<UnreadMessageTargetPartition> {
  if (messages.length === 0) {
    const empty: UnreadMessageTargetPartitionResult = {
      deliverableIds: [],
      ordinaryIds: [],
      verifiedTargetedIds: [],
      verifiedPlacements: [],
      held: []
    }
    return { ...empty, reverifySync: () => empty }
  }
  const byId = readMessagesWorkTargetProvenance(
    db,
    messages.map((message) => message.id)
  )
  const verificationByKey = new Map<string, PlacementVerdict>()
  const entries: PartitionEntry[] = []

  for (const message of messages) {
    const entry = byId.get(message.id)
    if (!entry || entry.kind === 'absent') {
      entries.push({ kind: 'ordinary', messageId: message.id })
      continue
    }
    if (entry.kind === 'corrupt') {
      entries.push({ kind: 'held', messageId: message.id, reason: entry.reason })
      continue
    }
    const key = JSON.stringify(entry.placement)
    let verdict = verificationByKey.get(key)
    if (!verdict) {
      try {
        const verified = await verifyPlacement(entry.placement)
        verdict = { ok: true, placement: entry.placement, reverifySync: verified.reverifySync }
      } catch (error) {
        verdict = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      verificationByKey.set(key, verdict)
    }
    entries.push({ kind: 'targeted', messageId: message.id, key, verdict })
  }

  const initial = evaluatePartitionEntries(entries, false)
  return {
    ...initial,
    reverifySync: () =>
      initial.verifiedTargetedIds.length === 0 ? initial : evaluatePartitionEntries(entries, true)
  }
}

/**
 * Partition unread messages for transfer into or consumption by `destinationDispatchId`.
 * Ordinary messages and matching targeted messages proceed; drifted/mismatched/corrupt ones stay held.
 */
export function partitionUnreadMessagesForWorkerDispatch(
  runtime: BotWorkTargetWorkspaceRuntime & Pick<OrcaRuntimeService, 'showTerminal'>,
  db: OrchestrationDb,
  destinationDispatchId: string,
  messages: readonly Pick<MessageRow, 'id'>[]
): Promise<UnreadMessageTargetPartition> {
  return partitionMessagesWithVerifier(db, messages, (placement) =>
    verifyLocalWorkerDispatchMatchesWorkTarget(runtime, db, destinationDispatchId, placement)
  )
}

/** Partition unread messages against a bare terminal or standalone session recipient (including Run coordinators). */
export function partitionUnreadMessagesForBareRecipient(
  runtime: BotWorkTargetWorkspaceRuntime &
    Pick<OrcaRuntimeService, 'showTerminal' | 'getOrchestrationDispatchAuthority'>,
  db: OrchestrationDb,
  recipient: string,
  messages: readonly Pick<MessageRow, 'id'>[]
): Promise<UnreadMessageTargetPartition> {
  return partitionMessagesWithVerifier(db, messages, (placement) =>
    verifyBareRecipientMatchesWorkTarget(runtime, recipient, placement)
  )
}

/** Partition unread messages against a concrete placed local workspace before terminal authority is bound. */
export function partitionUnreadMessagesForResolvedWorkspace(
  runtime: BotWorkTargetWorkspaceRuntime,
  db: OrchestrationDb,
  target: {
    worktreeId: string
    recipientLabel: string
    workerHostScope?: string | null
    workerWorkspaceInstanceId?: string | null
  },
  messages: readonly Pick<MessageRow, 'id'>[]
): Promise<UnreadMessageTargetPartition> {
  return partitionMessagesWithVerifier(db, messages, (placement) =>
    verifyLocalWorkspaceMatchesWorkTarget(runtime, {
      worktreeId: target.worktreeId,
      workTarget: placement,
      recipientLabel: target.recipientLabel,
      workerHostScope: target.workerHostScope,
      workerWorkspaceInstanceId: target.workerWorkspaceInstanceId,
      requireRecordedInstanceId: Boolean(placement.expectedWorkspaceInstanceId)
    })
  )
}

/** Query unread current-delivery messages in `sourceMailbox` for `runId` (bounded by optional sequence) and partition them against `destinationDispatchId`. */
export async function verifyUnreadMailboxMessagesForWorkerDispatch(
  runtime: BotWorkTargetWorkspaceRuntime & Pick<OrcaRuntimeService, 'showTerminal'>,
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
