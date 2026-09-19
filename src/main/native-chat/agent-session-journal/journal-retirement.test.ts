import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from './journal-store-test-open'
import type { AgentSessionJournal } from './journal-store'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import { deleteJournalRepairedSuffix } from './journal-repair-marker'
import { MAX_JOURNAL_RETIREMENT_TARGETS } from './journal-retirement'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session',
  hostId: 'host',
  workspaceId: 'folder',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread' }
}
const itemIdentity = { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 1 } as const
const running = { kind: 'turn', turnId: 'turn', state: 'running' } as const
const retired = { kind: 'turn', turnId: 'turn', state: 'unverifiable' } as const
const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-retirement-'))
  journal = await journals.open({ identity, journalDir: root })
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
async function capture() {
  const result = await journal.retirement.capture()
  if (result.disposition !== 'captured') {
    throw new Error(result.reason)
  }
  return result.capture
}
async function capturedTurn() {
  await journal.appendItem(itemIdentity, running, { fence: 1 })
  const boundary = await capture()
  const target = boundary.items[0]
  if (!target) {
    throw new Error('missing target')
  }
  return { capture: boundary, target, fence: 1, body: retired }
}

describe('conditional historical retirement', () => {
  it('retires exact old work after new unrelated writes and survives replay', async () => {
    const input = await capturedTurn()
    await journal.appendItem(
      { ...itemIdentity, turnId: 'new' },
      { ...running, turnId: 'new' },
      { fence: 2 }
    )
    expect(await journal.retirement.repairItem({ ...input, fence: 2 })).toMatchObject({
      changed: true
    })
    expect(await journal.retirement.repairItem({ ...input, fence: 2 })).toMatchObject({
      changed: false
    })
    await journal.close()
    journal = await journals.open({ identity, journalDir: root })
    expect(await journal.retirement.repairItem({ ...input, fence: 2 })).toMatchObject({
      changed: false
    })
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      retired,
      { ...running, turnId: 'new' }
    ])
  })

  it('checks new revisions inside the writer queue', async () => {
    const input = await capturedTurn()
    const newer = journal.appendItem(itemIdentity, running, { fence: 1 })
    const delayed = journal.retirement.repairItem(input)
    await newer
    expect(await delayed).toMatchObject({ changed: false })
    expect(journal.snapshot().items[0]?.body).toEqual(running)
  })

  it('supersedes targets after tombstone and same-ID re-add', async () => {
    const input = await capturedTurn()
    await journal.appendTombstone(itemIdentity, { fence: 1 })
    await journal.appendItem(itemIdentity, running, { fence: 1 })
    expect(await journal.retirement.repairItem(input)).toMatchObject({ changed: false })
  })

  it('supersedes targets after epoch replacement', async () => {
    const input = await capturedTurn()
    await journal.replaceEpochItems('unreconcilable_prefix', 1, [
      { identity: itemIdentity, body: running }
    ])
    expect(await journal.retirement.repairItem(input)).toMatchObject({ changed: false })
  })

  it('rejects identical sequence/revision reuse after destructive suffix repair', async () => {
    const input = await capturedTurn()
    const epoch = journal.epoch
    await journal.close()
    const { db } = openJournalDatabase(journalDatabaseFile(root))
    try {
      deleteJournalRepairedSuffix({
        db,
        sessionId: identity.sessionId,
        epoch,
        fromSeq: input.target.mutationSequence,
        contentFrom: input.target.mutationSequence,
        now: 100
      })
    } finally {
      db.close()
    }
    journal = await journals.open({ identity, journalDir: root })
    await journal.appendItem(itemIdentity, running, { fence: 1 })
    expect(journal.snapshot().items[0]?.revision).toBe(input.target.revision)
    expect(await journal.retirement.repairItem(input)).toMatchObject({ changed: false })
  })

  it('keeps new dispatch observations and aliases ahead of old submission repair', async () => {
    await journal.appendSubmission({
      clientMessageId: 'send',
      payloadFingerprint: 'payload',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      fence: 1
    })
    const boundary = await capture()
    const target = boundary.submissions[0]
    if (!target) {
      throw new Error('missing submission')
    }
    await journal.resolveDispatch({ clientMessageId: 'send', state: 'unknown', fence: 1 })
    await journal.resolveDispatch({ clientMessageId: 'send', state: 'pending', fence: 1 })
    expect(
      await journal.retirement.repairSubmission({
        capture: boundary,
        target,
        fence: 1,
        reason: 'ended'
      })
    ).toMatchObject({ changed: false })
    const current = await capture()
    const latest = current.submissions[0]
    if (!latest) {
      throw new Error('missing latest')
    }
    await journal.resolveDispatch({
      clientMessageId: 'send',
      state: 'accepted',
      providerIdentity: itemIdentity,
      fence: 1
    })
    expect(
      await journal.retirement.repairSubmission({
        capture: current,
        target: latest,
        fence: 1,
        reason: 'ended'
      })
    ).toMatchObject({ changed: false })
    expect(journal.submissions()[0]?.dispatchState).toBe('accepted')
  })

  it('new alias adoption supersedes an item target without revising its original row', async () => {
    const input = await capturedTurn()
    await journal.appendSubmission({
      clientMessageId: 'alias-send',
      payloadFingerprint: 'payload',
      body: { kind: 'message', role: 'user', blocks: [] },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'alias-send',
      state: 'accepted',
      providerIdentity: itemIdentity,
      fence: 1
    })
    expect(await journal.retirement.repairItem(input)).toMatchObject({ changed: false })
  })

  it('materializes unknown only once without allowing a resend', async () => {
    await journal.appendSubmission({
      clientMessageId: 'send',
      payloadFingerprint: 'payload',
      body: { kind: 'message', role: 'user', blocks: [] },
      fence: 1
    })
    const boundary = await capture()
    const target = boundary.submissions[0]
    if (!target) {
      throw new Error('missing submission')
    }
    const input = { capture: boundary, target, fence: 1, reason: 'ended' }
    expect(await journal.retirement.repairSubmission(input)).toMatchObject({ changed: true })
    expect(await journal.retirement.repairSubmission(input)).toMatchObject({ changed: false })
    expect(journal.submissions()[0]).toMatchObject({ dispatchState: 'unknown', recovered: true })
  })

  it('explicitly abandons oversized capture and closed journals', async () => {
    for (let i = 0; i <= MAX_JOURNAL_RETIREMENT_TARGETS; i++) {
      await journal.appendItem({ ...itemIdentity, ordinal: i }, running, { fence: 1 })
    }
    expect(await journal.retirement.capture()).toEqual({
      disposition: 'abandoned',
      reason: 'quota'
    })
    await journal.close()
    expect(await journal.retirement.capture()).toEqual({
      disposition: 'abandoned',
      reason: 'unreadable'
    })
  })
})
