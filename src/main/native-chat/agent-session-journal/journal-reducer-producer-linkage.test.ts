import { describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import { buildJournalItemRow, journalLifecycleBatchRowBuilder } from './journal-row-builders'

const EPOCH = 'epoch-1'

function text(value: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function base(seq: number): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: 1, epoch: EPOCH, seq, fence: 1, ts: 1_000 + seq }
}

describe('producer linkage round-trips through the reducer', () => {
  const identity: AgentJournalItemIdentity = {
    provider: 'claude',
    sessionId: 'claude-session',
    uuid: 'child-1'
  }
  const linkage = {
    agentId: 'task-1',
    parentAgentId: 'task-parent',
    providerParentRef: 'toolu_1',
    producerKind: 'agent' as const,
    attempt: 2
  }

  it('copies the whole bundle onto the render item on the plain item path', () => {
    const state = createJournalReducerState('session-1', EPOCH)
    applyJournalRow(
      state,
      buildJournalItemRow({
        state,
        identity,
        body: text('looking'),
        seq: 1,
        fence: 1,
        ts: 1_001,
        linkage,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    )
    expect(renderJournalState(state).items[0]).toMatchObject(linkage)
  })

  it('copies it on the lifecycle-batch path too, which is a separate upsert', () => {
    const state = createJournalReducerState('session-1', EPOCH)
    applyJournalRow(state, {
      kind: 'lifecycle-batch',
      settlementId: 'settle-1',
      mutations: [{ kind: 'item', itemId: 'i-child', revision: 1, body: text('looking') }],
      ...base(1),
      ...linkage
    })
    expect(renderJournalState(state).items[0]).toMatchObject(linkage)
  })

  it('reads each mutation of a mixed batch as its own producer', () => {
    // A batch can CREATE rows several agents produced — a settlement landing
    // before any checkpoint did. The mutation that names a producer is that
    // producer's; the one naming none is the session's own, beside it.
    const state = createJournalReducerState('session-1', EPOCH)
    applyJournalRow(
      state,
      journalLifecycleBatchRowBuilder(
        () => state,
        'settle-mixed',
        [
          {
            kind: 'item',
            identity,
            body: text('child'),
            linkage,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          },
          {
            kind: 'item',
            identity: { provider: 'claude', sessionId: 'claude-session', uuid: 'own-1' },
            body: text('own'),
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ],
        { fence: 1 }
      )(1, 1_001)
    )

    const [child, own] = renderJournalState(state).items
    expect(child).toMatchObject({ body: text('child'), ...linkage })
    expect(own?.body).toEqual(text('own'))
    expect(own && 'agentId' in own).toBe(false)
  })

  it('lets a correction win over the provisional row, without moving the bubble', () => {
    // Write-through then correct: the row is written under the spawn call's own
    // id, then re-appended under the canonical one. Revision is assigned inside
    // the journal's serialized write step, so the later append always outranks
    // — and `sequence`/`observedAt` stay pinned, so re-attributing a row does
    // not relocate it in the timeline.
    const state = createJournalReducerState('session-1', EPOCH)
    const provisional = { agentId: 'toolu_1', providerParentRef: 'toolu_1' }
    applyJournalRow(
      state,
      buildJournalItemRow({
        state,
        identity,
        body: text('looking'),
        seq: 1,
        fence: 1,
        ts: 1_001,
        linkage: provisional,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    )
    applyJournalRow(
      state,
      buildJournalItemRow({
        state,
        identity,
        body: text('looking'),
        seq: 9,
        fence: 1,
        ts: 9_999,
        linkage,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    )

    const items = renderJournalState(state).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ revision: 2, ...linkage })
    expect(items[0]).toMatchObject({ sequence: 1, observedAt: 1_001 })
  })

  it('does not let a stale checkpoint undo a correction that already landed', () => {
    // A text checkpoint carrying the OLD stamp, submitted after the correction,
    // would re-root the row. It cannot: revision is read at write time, so the
    // last write wins and the lane resolves linkage fresh on every checkpoint.
    const state = createJournalReducerState('session-1', EPOCH)
    applyJournalRow(
      state,
      buildJournalItemRow({
        state,
        identity,
        body: text('a'),
        seq: 1,
        fence: 1,
        ts: 1,
        linkage,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    )
    applyJournalRow(
      state,
      buildJournalItemRow({
        state,
        identity,
        body: text('a and more'),
        seq: 2,
        fence: 1,
        ts: 2,
        linkage,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    )
    const items = renderJournalState(state).items
    expect(items[0]).toMatchObject({ revision: 2, ...linkage })
  })

  it('keeps linkage when a later revision rewrites the row', () => {
    // The resolved-append path lost the marker once before by rebuilding the
    // row without it, so the SECOND write is the one that matters here.
    const state = createJournalReducerState('session-1', EPOCH)
    for (const [seq, body] of [
      [1, text('look')],
      [2, text('looking at the lane')]
    ] as const) {
      applyJournalRow(
        state,
        buildJournalItemRow({
          state,
          identity,
          body,
          seq,
          fence: 1,
          ts: 1_000 + seq,
          linkage,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      )
    }
    const items = renderJournalState(state).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ revision: 2, ...linkage })
  })

  it("renders a row that predates linkage as the session's own", () => {
    const state = createJournalReducerState('session-1', EPOCH)
    applyJournalRow(state, {
      kind: 'item',
      itemId: 'i-legacy',
      revision: 1,
      body: text('written before linkage existed'),
      ...base(1)
    })
    const item = renderJournalState(state).items[0]
    expect(item && 'agentId' in item).toBe(false)
  })
})
