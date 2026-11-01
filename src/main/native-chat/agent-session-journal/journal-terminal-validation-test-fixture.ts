import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { settleStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-dead-generation-settlement'
import {
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { parseJournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'

export function createFixture() {
  const journals = createTrackedJournalOpener({ legacyInputs: true })

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

  return {
    expectRewriteTimes,
    expectSendStillWritable,
    expectUnadvanceableItemUntouched,
    identity,
    get journal() {
      return journal
    },
    set journal(value: typeof journal) {
      journal = value
    },
    journals,
    open,
    pendingApproval,
    get root() {
      return root
    },
    set root(value: typeof root) {
      root = value
    },
    saveOldItems,
    settle
  }
}
