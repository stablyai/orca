import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { prepareJsonlTranscriptImport } from '../../native-chat/agent-session-journal/history-import/journal-jsonl-import'
import { journalLifecycleItemMutation } from '../../native-chat/agent-session-journal/writing/journal-lifecycle-mutation'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId,
  createHistoryCatchUpBatch,
  type HistoryCatchUpContext,
  type HistoryCatchUpPlan,
  type HistoryCatchUpReplacementPlan
} from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'

export async function prepareClaudeTranscriptCapacityRecovery(
  input: {
    sessionId: string
    providerSessionId: string
    leafUuid: string
    filePath: string
    physicalCursor: AgentJournalCursor
  },
  {
    history,
    signal,
    check,
    warn
  }: Pick<HistoryCatchUpContext<unknown>, 'history' | 'signal' | 'check' | 'warn'>
): Promise<HistoryCatchUpPlan | HistoryCatchUpReplacementPlan> {
  const noticeIdentity = {
    provider: 'legacy' as const,
    agent: 'claude' as const,
    sessionId: input.sessionId,
    recordId: continuedOutsideRecordId(`capacity:${input.providerSessionId}:${input.leafUuid}`)
  }
  const prepared = await prepareJsonlTranscriptImport({
    agent: 'claude',
    transcriptAgent: 'claude',
    sessionId: input.providerSessionId,
    filePath: input.filePath,
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
    return batch.finish('claude-history-unloaded', input.physicalCursor)
  }
  const ids = prepared.items.flatMap((item) =>
    item.identity.provider === 'claude' ? [item.identity.uuid] : []
  )
  const providerHandle = {
    kind: 'claude' as const,
    sessionId: input.providerSessionId,
    leafUuid: ids.at(-1) ?? null
  }
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
        sourceConsumedBytes: prepared.sourceConsumedBytes
      },
      items: [
        {
          identity: noticeIdentity,
          body: continuedOutsideNotice(false, 'recent'),
          ownerFence: 0,
          turnScope: { kind: 'thread' }
        },
        ...prepared.items
      ]
    }
  }
}
