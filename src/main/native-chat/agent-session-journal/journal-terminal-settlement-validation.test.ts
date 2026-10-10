import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AgentJournalItemBodySchema } from '../../../shared/agent-session-journal-schemas'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { settleStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-dead-generation-settlement'
import {
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import * as rowTable from './journal-row-table'
import type { AgentSessionJournal } from './journal-store'

const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal
const identity = { provider: 'orca' as const, clientMessageId: 'old-turn' }

async function open() {
  return journals.open({
    identity: {
      sessionId: 'validation',
      workspaceId: 'folder',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    stateDirectory: root,
    now: () => 1_000
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-settlement-validation-'))
  journal = await open()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function settle(observedAt = 1_000, lastProvenAliveAt?: number) {
  return settleStaleStructuredAgentSessionState({
    journal,
    sessionId: 'validation',
    fence: 8,
    acquisitionGeneration: 'replacement',
    deathEvidence: {
      kind: lastProvenAliveAt === undefined ? 'exit-observed' : 'pid-absent',
      detail: '',
      ownerFence: 7,
      observedAt,
      ...(lastProvenAliveAt === undefined ? {} : { lastProvenAliveAt })
    }
  })
}

async function expectSendStillWritable() {
  const sequence = journal.cursor().sequence + 1
  await expect(
    journal.appendSubmission({
      clientMessageId: 'new-send',
      payloadFingerprint: 'new',
      fence: 8,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
    })
  ).resolves.toMatchObject({ sequence })
}

async function saveOldItems(inputs: { itemId: string; revision?: number; body: unknown }[]) {
  const { db } = openTestJournalHostDatabase(root)
  for (const [index, input] of inputs.entries()) {
    const json = JSON.stringify({
      v: 3,
      kind: 'item',
      epoch: journal.epoch,
      seq: index + 2,
      ts: 900,
      fence: 7,
      revision: 1,
      ...input,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(parseJournalRow(json).ok).toBe(true)
    insertTestJournalRowJson(db, 'validation', index + 2, json, 900)
  }
  await journal.close()
  journal = await open()
}

it.each([
  ['zero exit time', 0, undefined],
  ['zero renewal time', 1_000, 0]
] as const)(
  'ends an untimed turn with %s and still permits a fresh send',
  async (_name, observedAt, lastProvenAliveAt) => {
    await journal.appendItem(
      identity,
      { kind: 'turn', turnId: 'old', state: 'running' },
      {
        fence: 7,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
    await settle(observedAt, lastProvenAliveAt)
    expect(journal.itemBody(agentJournalItemKey(identity))).toEqual({
      kind: 'turn',
      turnId: 'old',
      state: 'interrupted'
    })
    expect(journal.activeTurnId()).toBeNull()
    const ended = journal.snapshot()
    await settle(observedAt, lastProvenAliveAt)
    expect(journal.snapshot()).toEqual(ended)
    await expectSendStillWritable()
  }
)

it.each([{ kind: 'tool-call' }, { providerTurnId: '' }])(
  'ends a readable legacy extension %j using a valid turn rewrite',
  async (extension) => {
    await saveOldItems([
      {
        itemId: agentJournalItemKey(identity),
        body: {
          kind: 'status',
          text: 'working',
          turnLifecycle: { turnId: 'old', state: 'running', ...extension }
        }
      }
    ])
    await settle()
    expect(journal.itemBody(agentJournalItemKey(identity))).toEqual({
      kind: 'turn',
      turnId: 'old',
      state: 'interrupted',
      completedAt: 1_000
    })
    expect(journal.activeTurnId()).toBeNull()
    await expectSendStillWritable()
  }
)

it.each([Number.MAX_SAFE_INTEGER + 1, 1e100])(
  'leaves exhausted saved revision %s untouched while other work commits once and a fresh send writes',
  async (revision) => {
    await expectUnadvanceableItemUntouched({
      itemId: agentJournalItemKey(identity),
      revision,
      body: { kind: 'turn', turnId: 'old', state: 'running' }
    })
    await expectSendStillWritable()
  }
)

async function expectUnadvanceableItemUntouched(saved: {
  itemId: string
  revision: number
  body: unknown
}) {
  await saveOldItems([
    saved,
    { itemId: 'orca:advanceable', body: { kind: 'turn', turnId: 'other', state: 'running' } },
    { itemId: 'orca:approval', body: pendingApproval() }
  ])
  const before = journal.snapshot().items.find((item) => item.itemId === saved.itemId)
  const { db } = openTestJournalHostDatabase(root)
  const history = liveTestJournalRows(db, 'validation')
  const commits = vi.fn()
  journal.observeCommits(commits)
  await expect(settle()).resolves.toBeGreaterThan(0)
  expect(commits).toHaveBeenCalledTimes(1)
  expect(journal.snapshot().items.find((item) => item.itemId === saved.itemId)).toEqual(before)
  expect(journal.itemBody('orca:advanceable')).toMatchObject({ state: 'interrupted' })
  expect(journal.itemBody('orca:approval')).toMatchObject({ resolution: { state: 'cancelled' } })
  expect(liveTestJournalRows(db, 'validation').slice(0, history.length)).toEqual(history)
  const settled = journal.snapshot()
  await settle()
  expect(journal.snapshot()).toEqual(settled)
  expect(commits).toHaveBeenCalledTimes(1)
  await journal.close()
  journal = await open()
  expect(journal.snapshot()).toEqual(settled)
}

it('revises the original legacy long prompt key and still permits a fresh send', async () => {
  const oldKey = `orca:${'x'.repeat(1025)}`
  await saveOldItems([{ itemId: oldKey, body: pendingApproval() }])
  await settle()
  expect(journal.snapshot().items).toHaveLength(1)
  expect(journal.itemBody(oldKey)).toMatchObject({ resolution: { state: 'cancelled' } })
  expect(journal.snapshot().items.filter((item) => item.body.kind === 'approval')).toHaveLength(1)
  await expectSendStillWritable()
})

function pendingApproval() {
  return {
    kind: 'approval',
    title: 'Allow?',
    detail: null,
    options: [],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

function expectRewriteTimes(value: unknown) {
  if (typeof value !== 'object' || value === null) {
    return
  }
  for (const [key, field] of Object.entries(value)) {
    if (key.endsWith('At') && field !== null && field !== undefined) {
      expect(typeof field).toBe('number')
      expect(Number.isFinite(field)).toBe(true)
      expect(field).toBeGreaterThan(0)
    }
    expectRewriteTimes(field)
  }
}

it.each([
  ['untimed exit', 0, undefined],
  ['untimed renewal', 1_000, 0],
  ['timed exit', 1_000, undefined]
] as const)(
  'builds admitted settlement rows preserving extensions without invalid known times for %s',
  async (_name, observedAt, lastProvenAliveAt) => {
    const long = 'x'.repeat(1025)
    const running = { turnId: 'old', state: 'running' }
    const laterContextUsage = {
      window: { tokens: 100, capturedAt: 1, laterWindowField: true },
      used: { kind: 'unknown', capturedAt: 1, laterUsedField: true },
      laterUsageField: { kept: true }
    }
    const extensionBodies = [
      { ...running, kind: 'tool-call' },
      { ...running, providerTurnId: '' },
      { ...running, providerTurnId: 42 },
      { ...running, providerTurnId: null },
      { ...running, contextUsage: { window: { tokens: -1 } } },
      { ...running, contextUsage: 'extension' },
      {
        ...running,
        providerTurnId: 'provider',
        contextUsage: laterContextUsage
      },
      { ...running, laterField: { kind: 'tool-call' } }
    ]
    const inputs = [
      ...extensionBodies.map((turnLifecycle, index) => ({
        itemId: `orca:extension-${index}`,
        body: { kind: 'status', text: 'working', turnLifecycle }
      })),
      { itemId: 'orca:untimed', body: { kind: 'turn', ...running } },
      {
        itemId: 'orca:timed',
        body: { kind: 'turn', ...running, requestedAt: 800, startedAt: 900, completedAt: 950 }
      },
      {
        itemId: 'orca:last-advanceable',
        revision: Number.MAX_SAFE_INTEGER - 1,
        body: { kind: 'turn', ...running }
      },
      { itemId: `orca:${long}`, body: pendingApproval() },
      { itemId: `claude:${long}:uuid`, body: { kind: 'turn', ...running } },
      {
        itemId: `codex:thread:${long}:0`,
        body: { kind: 'message', role: 'reasoning', blocks: [], state: 'running' }
      },
      {
        itemId: `legacy:codex:session:${long}`,
        body: { kind: 'tool-call', name: 'shell', state: 'running' }
      },
      { itemId: 'future-provider:opaque%ZZ', body: pendingApproval() },
      { itemId: 'orca:%78', body: pendingApproval() },
      { itemId: '', body: pendingApproval() },
      {
        itemId: `orca:${long}oversized`,
        body: { kind: 'tool-call', name: 'shell', input: 'x'.repeat(1_500_001), state: 'running' }
      }
    ]
    await saveOldItems(inputs)
    const { db } = openTestJournalHostDatabase(root)
    const history = liveTestJournalRows(db, 'validation')
    const rows: JournalRow[] = []
    const insert = rowTable.insertJournalRow
    vi.spyOn(rowTable, 'insertJournalRow').mockImplementation((database, sessionId, row) => {
      expect(parseJournalRow(JSON.stringify(row))).toMatchObject({ ok: true })
      const bodies =
        row.kind === 'item'
          ? [row.body]
          : row.kind === 'lifecycle-batch'
            ? row.mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : []))
            : []
      for (const body of bodies) {
        expect(body).toMatchObject(AgentJournalItemBodySchema.parse(body))
        expectRewriteTimes(body)
      }
      rows.push(row)
      return insert(database, sessionId, row)
    })
    await settle(observedAt, lastProvenAliveAt)
    expect(rows.some((row) => row.kind === 'lifecycle-batch')).toBe(true)
    expect(rows.some((row) => row.kind === 'item' && row.itemId === `orca:${long}oversized`)).toBe(
      true
    )
    expect(liveTestJournalRows(db, 'validation').slice(0, history.length)).toEqual(history)
    for (const input of inputs) {
      const body = journal.itemBody(input.itemId)
      expect(body).toBeDefined()
      expect(readAgentJournalTurn(body ?? undefined)?.state).not.toBe('running')
      if (body?.kind === 'approval') {
        expect(body.resolution.state).toBe('cancelled')
      }
      if (body?.kind === 'message') {
        expect(body.state).toBe('completed')
      }
      if (body?.kind === 'tool-call') {
        expect(body.state).toBe('failed')
      }
    }
    expect(journal.itemBody('orca:extension-7')).toHaveProperty('laterField', { kind: 'tool-call' })
    expect(journal.itemBody('orca:extension-6')).toHaveProperty('contextUsage', laterContextUsage)
    expect(journal.activeTurnId()).toBeNull()
    expect(journal.snapshot().items).toHaveLength(inputs.length + 1)
    const ended = journal.snapshot()
    await settle(observedAt, lastProvenAliveAt)
    expect(journal.snapshot()).toEqual(ended)
    await journal.close()
    journal = await open()
    for (const input of inputs) {
      expect(journal.itemBody(input.itemId)).toEqual(
        ended.items.find((item) => item.itemId === input.itemId)?.body
      )
    }
    await expectSendStillWritable()
  }
)

it.each([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER - 1])(
  'advances readable saved revision %s using the existing integer admission',
  async (revision) => {
    await saveOldItems([
      {
        itemId: agentJournalItemKey(identity),
        revision,
        body: { kind: 'turn', turnId: 'old', state: 'running' }
      }
    ])
    await settle()
    expect(journal.snapshot().items[0]).toMatchObject({
      revision: Math.max(revision, 0) + 1,
      body: { state: 'interrupted' }
    })
    await expectSendStillWritable()
  }
)

it('admits an answer on an exhausted approval without changing the saved item', async () => {
  await saveOldItems([
    {
      itemId: agentJournalItemKey(identity),
      revision: Number.MAX_SAFE_INTEGER + 1,
      body: pendingApproval()
    }
  ])
  const before = journal.snapshot().items[0]
  const cursor = journal.cursor()
  await expect(
    journal.appendItem(
      identity,
      {
        ...pendingApproval(),
        kind: 'approval',
        resolution: {
          state: 'resolved',
          selectedOptionId: null,
          resolvedBy: 'user',
          resolvedAt: 1_000
        }
      },
      { fence: 8, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  ).resolves.toBeDefined()
  expect(journal.cursor().sequence).toBe(cursor.sequence + 1)
  expect(journal.snapshot().items[0]).toEqual(before)
  await expectSendStillWritable()
})
