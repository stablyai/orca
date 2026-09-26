import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  buildJournalItemRow,
  buildJournalTombstoneRow,
  journalLifecycleBatchRowBuilder
} from './journal-row-builders'
import { createTrackedJournalOpener } from './journal-store-test-open'

// A row's producer is fixed by the write that created it. A revision naming no
// producer — a settlement, a prompt answer, a reopen sweep — keeps it; a
// revision naming one replaces the whole bundle, which is how a provisional
// stamp is corrected.

const child: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'child',
  turnId: 't',
  ordinal: 1
}
const own: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'root',
  turnId: 't',
  ordinal: 1
}
const linkage = {
  agentId: 'child',
  parentAgentId: 'spawner',
  providerParentRef: 'call-1',
  producerKind: 'agent' as const,
  attempt: 2
}

function text(value: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function producerOf(item: AgentJournalRenderItem | undefined) {
  if (!item) {
    return undefined
  }
  const { agentId, parentAgentId, providerParentRef, producerKind, attempt } = item
  return { agentId, parentAgentId, providerParentRef, producerKind, attempt }
}

const NO_PRODUCER = {
  agentId: undefined,
  parentAgentId: undefined,
  providerParentRef: undefined,
  producerKind: undefined,
  attempt: undefined
}

function seeded() {
  const state = createJournalReducerState('session-1', 'epoch-1')
  let seq = 0
  const write = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalMessageItem,
    stamp?: Parameters<typeof buildJournalItemRow>[0]['linkage']
  ) => {
    seq += 1
    applyJournalRow(
      state,
      buildJournalItemRow({
        state,
        identity,
        body,
        seq,
        fence: 1,
        ts: 1_000 + seq,
        ...(stamp ? { linkage: stamp } : {}),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    )
  }
  const settle = (identities: AgentJournalItemIdentity[]) => {
    seq += 1
    applyJournalRow(
      state,
      journalLifecycleBatchRowBuilder(
        () => state,
        `settle-${seq}`,
        identities.map((identity) => ({
          kind: 'item' as const,
          identity,
          body: text('settled'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })),
        { fence: 1 }
      )(seq, 1_000 + seq)
    )
  }
  const remove = (identity: AgentJournalItemIdentity) => {
    seq += 1
    const itemId = agentJournalItemKey(identity)
    applyJournalRow(
      state,
      buildJournalTombstoneRow({ state, itemId, seq, fence: 1, ts: 1_000 + seq })
    )
  }
  const item = (identity: AgentJournalItemIdentity) =>
    state.items.get(agentJournalItemKey(identity))
  return { state, write, settle, remove, item }
}

describe('producer inheritance in the reducer', () => {
  it('keeps the whole bundle when a plain revision names no producer', () => {
    const { write, item } = seeded()
    write(child, text('looking'), linkage)
    write(child, text('looked'))

    expect(item(child)).toMatchObject({ revision: 2, body: text('looked'), sequence: 1 })
    expect(producerOf(item(child))).toEqual(linkage)
  })

  it("keeps each row's own producer when one batch settles a child's row and the session's", () => {
    const { write, settle, item } = seeded()
    write(child, text('child working'), linkage)
    write(own, text('own working'))
    settle([child, own])

    expect(item(child)).toMatchObject({ revision: 2, body: text('settled') })
    expect(producerOf(item(child))).toEqual(linkage)
    expect(item(own)).toMatchObject({ revision: 2, body: text('settled') })
    expect(producerOf(item(own))).toEqual(NO_PRODUCER)
  })

  it('replaces the bundle wholesale when a revision names any producer', () => {
    const { write, item } = seeded()
    write(child, text('looking'), linkage)
    write(child, text('looking'), { agentId: 'task-1', producerKind: 'agent' })

    expect(producerOf(item(child))).toEqual({
      ...NO_PRODUCER,
      agentId: 'task-1',
      producerKind: 'agent'
    })
  })

  it('gives a row re-created after its removal nothing from the removed one', () => {
    const { write, remove, item } = seeded()
    write(child, text('first life'), linkage)
    remove(child)
    write(child, text('second life'))

    expect(item(child)?.body).toEqual(text('second life'))
    expect(producerOf(item(child))).toEqual(NO_PRODUCER)
  })
})

describe('producer inheritance across a reopen', () => {
  let root: string
  const journals = createTrackedJournalOpener()
  const open = () =>
    journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'root' }
      },
      journalDir: root,
      now: () => 1_000
    })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-producer-inheritance-'))
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  it('replays an inherited producer from disk exactly as it was folded live', async () => {
    const journal = await open()
    await journal.appendItem(child, text('working'), {
      fence: 1,
      ...linkage,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.appendItem(own, text('working'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.appendItem(child, text('still working'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.appendLifecycleBatch({
      settlementId: 'settle-1',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: child,
          body: text('settled'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        {
          kind: 'item',
          identity: own,
          body: text('settled'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
    })
    const live = journal.snapshot().items
    expect(live.map((item) => [item.revision, producerOf(item)])).toEqual([
      [3, linkage],
      [2, NO_PRODUCER]
    ])

    await journal.close()
    const reopened = await open()
    expect(reopened.snapshot().items).toEqual(live)
  })
})
