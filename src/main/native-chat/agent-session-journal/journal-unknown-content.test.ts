// Inside a row of a known kind, what a newer build wrote is never damage. A body of a kind this
// build does not know (or a plan subject of one) is kept and the chat stays writable; a mutation or
// sent message of a newer kind fails the load as a newer Orca's chat with every row kept as it was,
// even beside damage. Anything else that fails is damage: the chat fails to load, every row kept.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-newer-content',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const SCOPE = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-newer-content-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function open() {
  return journals.open({ identity: IDENTITY, stateDirectory: root })
}

function stored(): { seq: number; rowJson: string }[] {
  return liveTestJournalRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId).map(
    (row) => ({ seq: row.seq, rowJson: row.rowJson })
  )
}

/** An anchor, two items, then `rows` as a newer build (or damage) wrote them, then one more item
 *  of this build's: closed, so the next open replays all of it. */
async function journalWith(rows: (epoch: string) => Record<string, unknown>[]) {
  const first = await open()
  await first.appendItem(item(0), { kind: 'status', text: 'one' }, SCOPE)
  await first.appendItem(item(1), { kind: 'status', text: 'two' }, SCOPE)
  const epoch = first.epoch
  let seq = first.cursor().sequence
  await journals.closeAll()
  const tail = itemRow(epoch, 'codex:thread-1:turn-1:9', { kind: 'status', text: 'after' })
  const { db } = openTestJournalHostDatabase(root)
  for (const row of [...rows(epoch), tail]) {
    seq += 1
    insertTestJournalRowJson(db, IDENTITY.sessionId, seq, JSON.stringify({ ...row, seq }), 5_000)
  }
  closeTestJournalHostDatabase(root)
  return { written: stored() }
}

function itemRow(epoch: string, itemId: string, body: Record<string, unknown>) {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch,
    fence: 1,
    ts: 5_000,
    kind: 'item',
    itemId,
    revision: 1,
    body
  }
}

function batchRow(epoch: string, mutations: Record<string, unknown>[]) {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch,
    fence: 1,
    ts: 5_000,
    kind: 'lifecycle-batch',
    settlementId: 'settle-1',
    mutations
  }
}

const NEWER_BODY = { kind: 'plan-card', steps: [{ text: 'by a newer build' }] }
const PLAN_APPROVAL = {
  kind: 'approval',
  title: 'Approve the plan?',
  detail: null,
  options: [{ id: 'yes', label: 'Yes' }],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null },
  subject: { kind: 'plan', text: 'Step one' }
}

/** Refused as a newer Orca's chat on every open, with every row left as it was. */
async function expectNewerAndKept(written: { seq: number; rowJson: string }[]) {
  await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
  await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
  expect(stored()).toEqual(written)
}

/** Opens writable, keeps the newer item in the snapshot, takes a write, and leaves every earlier
 *  row byte-identical. */
async function expectWritableAndKept(written: { seq: number; rowJson: string }[], itemId: string) {
  const journal = await open()
  expect(journal.snapshot().items.some((entry) => entry.itemId === itemId)).toBe(true)
  await journal.appendItem(item(5), { kind: 'status', text: 'taken' }, SCOPE)
  await journals.closeAll()
  expect(stored().slice(0, written.length)).toEqual(written)
}

describe("a newer build's body kind, kept and writable", () => {
  it.each([
    ['an item body of a newer kind', NEWER_BODY],
    ['a plan subject of a newer kind', { ...PLAN_APPROVAL, subject: { kind: 'diff' } }]
  ])('keeps %s and stays writable', async (_name, body) => {
    const { written } = await journalWith((epoch) => [
      itemRow(epoch, 'codex:thread-1:turn-1:2', body)
    ])
    await expectWritableAndKept(written, 'codex:thread-1:turn-1:2')
  })

  it('keeps a lifecycle mutation whose body is a newer kind, and stays writable', async () => {
    const { written } = await journalWith((epoch) => [
      batchRow(epoch, [
        { kind: 'item', itemId: 'codex:thread-1:turn-1:4', revision: 1, body: NEWER_BODY }
      ])
    ])
    await expectWritableAndKept(written, 'codex:thread-1:turn-1:4')
  })
})

describe("a newer build's row content that stays a closed set", () => {
  it.each([['of a newer kind', { kind: 'pin', itemId: 'codex:thread-1:turn-1:3', revision: 2 }]])(
    'fails the load on a lifecycle mutation %s',
    async (_name, mutation) => {
      const { written } = await journalWith((epoch) => [
        batchRow(epoch, [
          {
            kind: 'item',
            itemId: 'codex:thread-1:turn-1:3',
            revision: 1,
            body: { kind: 'status', text: 'ok' }
          },
          mutation
        ])
      ])
      await expectNewerAndKept(written)
    }
  )

  it('fails the load on a submission whose body is a newer kind', async () => {
    const { written } = await journalWith((epoch) => [
      {
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch,
        fence: 1,
        ts: 5_000,
        kind: 'submission',
        clientMessageId: 'client-1',
        payloadFingerprint: 'f',
        providerHandle: IDENTITY.providerHandle,
        body: { kind: 'voice-note', clip: 'by a newer build' }
      }
    ])
    await expectNewerAndKept(written)
  })

  it('fails the load on a newer mutation kind that carries no item id', async () => {
    const { written } = await journalWith((epoch) => [
      batchRow(epoch, [{ kind: 'turn-settle', turnId: 'turn-1', outcome: 'done' }])
    ])
    await expectNewerAndKept(written)
  })

  it.each([
    [
      'a row',
      (epoch: string) => ({
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch,
        fence: 1,
        ts: 5_000,
        kind: 'submission',
        clientMessageId: 'client-1',
        payloadFingerprint: 7,
        providerHandle: IDENTITY.providerHandle,
        body: { kind: 'voice-note', clip: 'by a newer build' }
      })
    ],
    [
      'a batch',
      (epoch: string) =>
        batchRow(epoch, [
          { kind: 'item', itemId: 'codex:thread-1:turn-1:3', revision: 1, body: { kind: 'diff' } },
          { kind: 'pin' }
        ])
    ]
  ])('fails the load as newer when damage sits beside newer content in %s', async (_where, row) => {
    const { written } = await journalWith((epoch) => [row(epoch)])
    await expectNewerAndKept(written)
  })
})

describe("a turn's context usage of a newer shape", () => {
  it('is dropped like an unusable annotation: the chat stays writable and keeps the row', async () => {
    const { written } = await journalWith((epoch) => [
      itemRow(epoch, 'codex:thread-1:turn-1:2', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'completed',
        contextUsage: { used: { kind: 'measured', capturedAt: 1 } }
      })
    ])
    const journal = await open()
    expect(journal.snapshot().items[2]?.body).toEqual({
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed'
    })
    await journals.closeAll()
    expect(stored()).toEqual(written)
  })
})

describe('damage', () => {
  it.each([
    ['a broken required field', { kind: 'diff', path: 'a.ts', patch: { head: 'x' } }],
    [
      'a broken optional value',
      { kind: 'turn', turnId: 'turn-1', state: 'done', durationMs: null }
    ],
    [
      'a turn lifecycle whose turn is a number',
      { kind: 'status', text: 'Turn started', turnLifecycle: { turnId: 7, state: 'running' } }
    ],
    ['an empty plan', { ...PLAN_APPROVAL, subject: { kind: 'plan', text: '' } }]
  ])('fails the load from %s, and every row is kept', async (_name, body) => {
    const { written } = await journalWith((epoch) => [
      itemRow(epoch, 'codex:thread-1:turn-1:2', body)
    ])
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(open()).rejects.toMatchObject({
        refusal: {
          code: 'agent_session_journal_unreadable',
          details: { reason: 'journalCorrupt' }
        }
      })
    }
    expect(stored()).toEqual(written)
  })
})
