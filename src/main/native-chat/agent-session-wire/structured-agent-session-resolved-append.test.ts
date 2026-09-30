import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget,
  type StructuredAgentSessionRevisionResolver
} from './structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'

const ROW: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: 'row' }

const text = (value: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: value }]
})

function textOf(body: AgentJournalItemBody | undefined): string {
  const block = body?.kind === 'message' ? body.blocks[0] : undefined
  return block?.type === 'text' ? block.text : ''
}

/** A journal whose appends land a tick later, so an unserialized read would race. */
function journalTarget(rows: Map<string, AgentJournalItemBody>): StructuredAgentSessionEventTarget {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a double for the journal methods the resolved paths call.
  const journal = {
    epoch: 'e',
    appendItem: vi.fn(async (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      rows.set(agentJournalItemKey(identity), body)
      return { cursor: { epoch: 'e', sequence: rows.size } }
    }),
    visitItems: (visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void) => {
      let sequence = 0
      for (const [itemId, body] of rows) {
        visit(itemId, ++sequence, body)
      }
    }
  } as unknown as AgentSessionJournal
  return { journal, fence: 1, publish: vi.fn() }
}

const appendSuffix =
  (suffix: string): StructuredAgentSessionRevisionResolver =>
  (journal) => {
    let current: AgentJournalItemBody | undefined
    journal.visitItems((itemId, _sequence, body) => {
      if (itemId === agentJournalItemKey(ROW)) {
        current = body
      }
    })
    return { identity: ROW, body: text(`${textOf(current)}${suffix}`) }
  }

describe('resolved revisions', () => {
  it('reads the row as the journal holds it when each queued revision runs', async () => {
    const rows = new Map<string, AgentJournalItemBody>()
    const deferred = createDeferredStructuredAgentSessionEventSink()
    const bytes = estimateStructuredAgentSessionItemBytes(ROW, text('abc'))
    for (const suffix of ['a', 'b', 'c']) {
      expect(
        deferred.sink.tryReviseResolvedItem?.(bytes, appendSuffix(suffix), {
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).toEqual({
        accepted: true
      })
    }
    // Three revisions of one row stay three operations; none replaces another.
    expect(deferred.state().queuedOperations).toBe(3)
    deferred.bind(journalTarget(rows))
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    expect(textOf(rows.get(agentJournalItemKey(ROW)))).toBe('abc')
  })

  it('skips a revision that resolves to nothing', async () => {
    const rows = new Map<string, AgentJournalItemBody>()
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.sink.tryReviseResolvedItem?.(1_000, () => null, {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const target = journalTarget(rows)
    deferred.bind(target)
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    expect(target.journal.appendItem).not.toHaveBeenCalled()
  })

  it('publishes a revision in the operation that writes it, within the same reservation', async () => {
    const rows = new Map<string, AgentJournalItemBody>()
    const deferred = createDeferredStructuredAgentSessionEventSink()
    const bytes = estimateStructuredAgentSessionItemBytes(ROW, text('a'))
    deferred.sink.tryReviseResolvedItemAndPublish?.(bytes, appendSuffix('a'), {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    deferred.sink.tryReviseResolvedItemAndPublish?.(bytes, () => null, {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const target = journalTarget(rows)
    const published: string[] = []
    vi.mocked(target.publish).mockImplementation(() =>
      published.push(textOf(rows.get(agentJournalItemKey(ROW))))
    )
    deferred.bind(target)
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    // Published once, after the append: the revision that resolves to nothing publishes nothing.
    expect(published).toEqual(['a'])
  })

  it('refuses a resolved write larger than the reservation it was admitted with', async () => {
    const rows = new Map<string, AgentJournalItemBody>()
    const deferred = createDeferredStructuredAgentSessionEventSink()
    const bytes = estimateStructuredAgentSessionItemBytes(ROW, text('a'))
    deferred.sink.tryReviseResolvedItem?.(
      bytes,
      () => ({
        identity: ROW,
        body: text('a'.repeat(64))
      }),
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    deferred.bind(journalTarget(rows))
    await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
    expect(rows.size).toBe(0)
  })
})
