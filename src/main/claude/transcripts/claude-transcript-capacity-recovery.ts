import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  usableJournalHistoryOrigin,
  type NativeCopyOrigin
} from '../../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import { prepareJsonlTranscriptImport } from '../../native-chat/agent-session-journal/history-import/journal-jsonl-import'
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
  const prepared = await prepareJsonlTranscriptImport({
    agent: 'claude',
    boundedClaude: true,
    transcriptAgent: 'claude',
    sessionId: input.providerSessionId,
    filePath: input.filePath,
    maxBytes: input.maxBytes,
    signal
  })
  check()
  if (!prepared.ok || !prepared.items.length) {
    warn('replacement-unreadable', prepared.ok ? undefined : prepared.error)
    const batch = createHistoryCatchUpBatch()
    const noticeKey = agentJournalItemKey(noticeIdentity)
    const notices = await history.reads.historyItems([noticeKey])
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
    const previous = usableJournalHistoryOrigin(await history.reads.historyOrigin())
    const ids =
      previous?.kind === 'native_copy' &&
      previous.agent === 'claude' &&
      previous.unit === 'claude-entry' &&
      previous.providerHandle.kind === 'claude' &&
      previous.providerHandle.sessionId === input.providerSessionId
        ? previous.ids
        : []
    // Refused scratch or worker certifies the unchanged source with one bounded probe, so a reopen
    // doesn't repeat the refused import; unreadable or changed sources stay uncertified.
    const receipt = prepared.ok
      ? prepared
      : prepared.cause instanceof ClaudeImportResourceError
        ? await probeRefusedSource(input.filePath, check)
        : undefined
    check()
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
  const kept = await keepSavedRecoveryText(prepared.items, history.reads, check)
  check()
  const ids = kept.items.flatMap((item) =>
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
      kept.addedBytes +
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
      items: [
        ...kept.items,
        {
          identity: noticeIdentity,
          // A passed-over record may be one of the newest turns, so the notice says newer turns are missing.
          body: continuedOutsideNotice(
            false,
            prepared.sourceSkippedRecords ? 'unloaded' : 'recent'
          ),
          ownerFence: 0,
          turnScope: { kind: 'thread' }
        }
      ]
    }
  }
}
