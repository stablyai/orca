import { setImmediate } from 'node:timers/promises'
import { applyClaudeImportFieldFragment } from '../../native-chat/agent-session-journal/history-import/journal-claude-import-window'
import type { JournalClaudeRecoveryRead } from '../../native-chat/agent-session-journal/journal-claude-recovery-reads'
import type { AgentSessionJournalReads } from '../../native-chat/agent-session-journal/journal-reads'
import { CLAUDE_IMPORT_PAGE_BYTES } from '../../native-chat/agent-session-journal/history-import/journal-claude-import-worker-protocol'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { NativeCopyOrigin } from '../../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import {
  MAX_LEGACY_IMPORT_RETAINED_BYTES,
  prepareJsonlTranscriptImport
} from '../../native-chat/agent-session-journal/history-import/journal-jsonl-import'
import { stat } from 'node:fs/promises'
import { ClaudeImportResourceError } from '../../native-chat/agent-session-journal/history-import/journal-claude-import-resource-error'
import { readClaudeTranscriptFrontier } from './claude-transcript-tail'
import { keepSavedRecoveryText } from './claude-transcript-recovery-saved-text'
import { journalLifecycleItemMutation } from '../../native-chat/agent-session-journal/writing/journal-lifecycle-mutation'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId,
  createHistoryCatchUpBatch,
  type HistoryCatchUpContext,
  type HistoryCatchUpPlan,
  type HistoryCatchUpReplacementPlan
} from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'

async function probeRefusedSource(filePath: string, check: () => void) {
  try {
    return await probeUnchangedSource(filePath, check)
  } catch {
    check()
    // An unreadable source stays uncertified; the notice still lands.
    return undefined
  }
}

async function probeUnchangedSource(filePath: string, check: () => void) {
  const { size, mtimeMs } = await stat(filePath)
  check()
  const sourceFrontier = await readClaudeTranscriptFrontier({
    filePath,
    consumedBytes: size,
    check
  })
  const after = await stat(filePath)
  // A write during the probe leaves the stretch for the next open.
  return after.size === size && after.mtimeMs === mtimeMs
    ? { sourceFrontier, sourceConsumedBytes: size, sourceMtimeMs: mtimeMs }
    : undefined
}

export async function prepareClaudeTranscriptCapacityRecovery(
  input: {
    sessionId: string
    providerSessionId: string
    leafUuid: string
    filePath: string
    physicalCursor: AgentJournalCursor
    maxBytes?: number
  },
  {
    history,
    signal,
    check,
    warn
  }: Pick<HistoryCatchUpContext<unknown>, 'history' | 'signal' | 'check' | 'warn'>
): Promise<HistoryCatchUpPlan | HistoryCatchUpReplacementPlan> {
  const noticeIdentity: AgentJournalItemIdentity = {
    provider: 'legacy',
    agent: 'claude',
    sessionId: input.sessionId,
    recordId: continuedOutsideRecordId(`capacity:${input.providerSessionId}:${input.leafUuid}`)
  }
  const notice = (skipped: number) => ({
    identity: noticeIdentity,
    // A passed-over record may be one of the newest turns.
    body: continuedOutsideNotice(false, skipped ? 'unloaded' : 'recent'),
    ownerFence: 0,
    turnScope: { kind: 'thread' as const }
  })
  const goal = await history.reads.claudeRecoveryGoal(input.physicalCursor)
  check()
  const prepared = await prepareJsonlTranscriptImport({
    agent: 'claude',
    boundedClaude: true,
    transcriptAgent: 'claude',
    sessionId: input.providerSessionId,
    filePath: input.filePath,
    maxBytes: input.maxBytes,
    signal,
    claudeRestore: {
      budget: ({ sourceSkippedRecords }) =>
        MAX_LEGACY_IMPORT_RETAINED_BYTES -
        Buffer.byteLength(JSON.stringify(notice(sourceSkippedRecords))),
      page: (items, remaining, checkTransfer) =>
        keepSavedRecoveryText(items, history.reads, input.physicalCursor, remaining, goal, () => {
          checkTransfer()
          check()
        })
    }
  })
  check()
  if (!prepared.ok || !prepared.items.length) {
    warn('replacement-unreadable', prepared.ok ? undefined : prepared.error)
    const batch = createHistoryCatchUpBatch()
    const noticeKey = agentJournalItemKey(noticeIdentity)
    const notices = await history.reads.historyItems([noticeKey], {
      includePlacement: false,
      maxReplyBytes: CLAUDE_IMPORT_PAGE_BYTES
    })
    check()
    const notice = notices.find(({ key }) => key === noticeKey)
    if (
      prepared.ok ||
      notice?.item?.body.kind !== 'status' ||
      notice.item.body.presentation !== 'continued-outside-unloaded'
    ) {
      const mutation = journalLifecycleItemMutation(
        { turnScope: { kind: 'thread' } },
        noticeIdentity,
        continuedOutsideNotice(false, 'unloaded')
      )
      if (notice?.item) {
        batch.revise(mutation, {
          canonicalItemId: notice.canonicalItemId,
          revision: notice.item.revision
        })
      } else {
        batch.push(mutation)
      }
    }
    // Refused scratch or worker certifies the unchanged source with one bounded probe, so a reopen
    // doesn't repeat the refused import; unreadable or changed sources stay uncertified.
    const receipt = prepared.ok
      ? prepared
      : prepared.cause instanceof ClaudeImportResourceError
        ? await probeRefusedSource(input.filePath, check)
        : undefined
    check()
    const previous =
      receipt &&
      (await history.reads.claudeRecoveryHeader({
        cursor: input.physicalCursor,
        providerSessionId: input.providerSessionId
      }))
    const ids = previous
      ? await readClaudeRecoveryIds(history.reads.claudeRecoveryOrigin, input.physicalCursor, check)
      : []
    const historyOrigin: NativeCopyOrigin | undefined = receipt
      ? {
          version: 1,
          kind: 'native_copy',
          agent: 'claude',
          unit: 'claude-entry',
          providerHandle: {
            kind: 'claude',
            sessionId: input.providerSessionId,
            leafUuid: input.leafUuid || null
          },
          ids,
          sourceFrontier: receipt.sourceFrontier,
          sourceConsumedBytes: receipt.sourceConsumedBytes,
          sourceMtimeMs: receipt.sourceMtimeMs
        }
      : undefined
    return batch.finish('claude-history-unloaded', input.physicalCursor, historyOrigin)
  }
  const ids = prepared.items.flatMap((item) =>
    item.identity.provider === 'claude' ? [item.identity.uuid] : []
  )
  const providerHandle = {
    kind: 'claude',
    sessionId: input.providerSessionId,
    leafUuid: ids.at(-1) ?? null
  } satisfies NativeCopyOrigin['providerHandle']
  return {
    kind: 'replace',
    // The window includes array punctuation; IDs appear again in the origin, outside the items.
    reservedBytes:
      prepared.retainedBytes +
      ids.reduce((bytes, id) => bytes + Buffer.byteLength(JSON.stringify(id)) + 1, 0) +
      Buffer.byteLength(
        JSON.stringify({ providerHandle, noticeIdentity, sourceFrontier: prepared.sourceFrontier })
      ) *
        2 +
      4096,
    operation: {
      kind: 'epoch-replace',
      reason: 'legacy_import',
      providerHandle,
      historyOrigin: {
        version: 1,
        kind: 'native_copy',
        agent: 'claude',
        unit: 'claude-entry',
        providerHandle,
        ids,
        sourceFrontier: prepared.sourceFrontier,
        sourceConsumedBytes: prepared.sourceConsumedBytes,
        sourceMtimeMs: prepared.sourceMtimeMs
      },
      items: [...prepared.items, notice(prepared.sourceSkippedRecords ?? 0)]
    }
  }
}

export async function readClaudeRecoveryIds(
  read: AgentSessionJournalReads['claudeRecoveryOrigin'],
  cursor: AgentJournalCursor,
  check: () => void
): Promise<string[]> {
  const origin: { ids: string[] } = { ids: [] }
  let after:
    | Extract<JournalClaudeRecoveryRead, { kind: 'claude-recovery-origin' }>['after']
    | null = { ordinal: 0, offset: 0 }
  while (after) {
    check()
    const page = await read({ cursor, after })
    check()
    for (const fragment of page.fragments) {
      applyClaudeImportFieldFragment(origin, fragment)
    }
    after = page.next
    if (after) {
      await setImmediate()
    }
  }
  return origin.ids
}
