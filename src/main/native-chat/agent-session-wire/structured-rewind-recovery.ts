import { restoreRewindJournalBody } from './structured-rewind-journal-body'
import { isDeepStrictEqual } from 'node:util'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session-rewind'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'

export function persistRewindRecord(
  store: AgentSessionRecordStore,
  sessionId: string,
  fence: number,
  rewind: AgentSessionRewindRecord
): Promise<unknown> {
  return store.transitionHandoff(sessionId, (record) => {
    if (record.lease.runtimeFence !== fence) {
      throw new Error('agent_session_checkpoint_stale')
    }
    return { ...record, rewind }
  })
}

/** Recovery observes provider state; it never repeats an ambiguous native mutation. */
export async function recoverStructuredRewind(
  store: AgentSessionRecordStore,
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number,
  adapter?: StructuredAgentSessionAdapter,
  now: () => number = Date.now
): Promise<void> {
  let rewind = store.getRecord(sessionId)?.rewind
  if (rewind?.phase !== 'provider-succeeded' && rewind?.phase !== 'prepared') {
    return
  }
  const target = parseAgentJournalItemKey(rewind.providerItemId ?? rewind.itemId)
  if (target?.provider === 'codex' && !rewind.hydrationVerified) {
    const recovered = await adapter?.recoverRewind?.({
      sessionId,
      fence,
      beforeTurnId: target.turnId
    })
    if (!recovered?.ok) {
      if (
        recovered?.reason === 'provider-refused' &&
        rewind.phase === 'prepared' &&
        !rewind.providerApplied
      ) {
        await persistRewindRecord(store, sessionId, fence, {
          ...rewind,
          phase: 'refused',
          reason: recovered.reason,
          retained: []
        })
        return
      }
      throw new Error(`agent_session_rewind:${recovered?.reason ?? 'outcome-unknown'}`)
    }
    const expectedItems = new Set(rewind.retained.map((item) => item.itemId))
    const observedItems = new Set<string>()
    for (const { identity } of recovered.items) {
      const itemId = agentJournalItemKey(identity)
      if (
        identity.provider !== 'codex' ||
        identity.threadId !== target.threadId ||
        !expectedItems.has(itemId)
      ) {
        throw new Error('agent_session_rewind:proof-mismatch')
      }
      observedItems.add(itemId)
    }
    if (observedItems.size !== expectedItems.size) {
      throw new Error('agent_session_rewind:proof-mismatch')
    }
    const retained = recovered.items.map(({ identity, body }) => ({
      itemId: agentJournalItemKey(identity),
      body,
      observedAt: now()
    }))
    if (
      retained.length > 10_000 ||
      Buffer.byteLength(JSON.stringify(retained), 'utf8') > AGENT_SESSION_HISTORY_MAX_PAGE_BYTES
    ) {
      throw new Error('agent_session_rewind:history-limit')
    }
    rewind = { ...rewind, retained, phase: 'provider-succeeded', hydrationVerified: true }
    await persistRewindRecord(store, sessionId, fence, rewind)
  }
  if (rewind.phase !== 'provider-succeeded') {
    return
  }
  const replacement = rewind.retained.map((item) => {
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity) {
      throw new Error('agent_session_rewind:invalid-retained-identity')
    }
    return { identity, body: restoreRewindJournalBody(item.body), observedAt: item.observedAt }
  })
  // A crash after the journal transaction must settle its existing epoch, not replace it twice.
  const alreadyReplaced = journal.cursor().epoch !== rewind.expectedEpoch
  if (
    alreadyReplaced &&
    !isDeepStrictEqual(
      journal.snapshot().items.map(({ itemId, body }) => ({ itemId, body })),
      replacement.map(({ identity, body }) => ({ itemId: agentJournalItemKey(identity), body }))
    )
  ) {
    throw new Error('agent_session_rewind:stale-epoch')
  }
  const cursor = alreadyReplaced
    ? journal.cursor()
    : await journal.replaceEpochItems('handle_forked', fence, replacement)
  await persistRewindRecord(store, sessionId, fence, {
    ...rewind,
    phase: 'completed',
    epoch: cursor.epoch,
    retained: []
  })
  await store.recordOperationOutcome({
    callerKey: rewind.callerKey,
    operationId: rewind.operationId,
    outcome: {
      status: 'succeeded',
      sessionId,
      rewind: { itemId: rewind.itemId, epoch: cursor.epoch }
    }
  })
}
