import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { JournalCommittedEffectError } from './journal-host-database'
import {
  createTrackedJournalOpener,
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'

const journals = createTrackedJournalOpener()
let root: string
const identity = {
  sessionId: 'replacement',
  workspaceId: 'ws',
  hostId: 'local',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('replacement')
}
const body: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'pending' }]
}
const oldItem = { provider: 'orca' as const, clientMessageId: 'old' }
const newItem = { provider: 'orca' as const, clientMessageId: 'new' }
const items = [{ identity: newItem, body: { kind: 'status' as const, text: 'new' }, ownerFence: 1 }]
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'orca-replacement-publication-'))
  const database = await openTestJournalHostDatabase(root)
  const journal = await journals.open({ stateDirectory: root, identity })
  await journal.appendItem(
    oldItem,
    { kind: 'status', text: 'old' },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendSubmission({
    clientMessageId: 'before',
    body,
    payloadFingerprint: 'a'.repeat(64),
    fence: 1
  })
  return { database, journal }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it('keeps held reads, capture lifetimes and specific Stop handles coherent across private publication', async () => {
  const { database, journal } = await fixture()
  await journal.appendStopEvent({ reason: 'user-stop' }, 1)
  const handle = journal.stopMarks.beginSettle(true)
  const lifetime = new AbortController()
  const captured = journal.inputOrder.captureKeys(new Set(), lifetime.signal)
  const cancelled = new AbortController()
  const aborted = journal.inputOrder.captureKeys(new Set(), cancelled.signal)
  const before = structuredClone(journal.snapshot())
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const snapshot = database.snapshot.bind(database)
  const hold = vi.spyOn(database, 'snapshot').mockImplementation(async (capture) => {
    const lease = await snapshot(capture)
    ready.resolve()
    await release.promise
    return lease
  })
  const retained = journal.readSinceView(
    journal.cursor(),
    100,
    () => undefined,
    (_since, view) => view.snapshot
  )
  await ready.promise
  hold.mockRestore()
  const duringLifetime = new AbortController()
  let during: typeof captured | undefined
  let secondHandle: typeof handle = null
  try {
    await journal.replaceEpochItems('handle_forked', 1, items, () => ({
      write: async () => {
        during = journal.inputOrder.captureKeys(new Set(), duringLifetime.signal)
        cancelled.abort()
        journal.stopMarks.settled(handle, 'old-turn')
        secondHandle = journal.stopMarks.beginSettle(true)
        journal.stopMarks.settled(handle, 'stale-turn')
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(journal.snapshot()).toEqual(before)
        expect(journal.stopMarks.latest()?.settle).toMatchObject({
          settling: true,
          turnId: 'old-turn'
        })
      },
      committed: () => {}
    }))
  } finally {
    release.resolve()
  }
  expect(await retained).toEqual(before)
  expect(journal.stopMarks.latest()?.settle).toMatchObject({ settling: true, turnId: 'old-turn' })
  journal.stopMarks.settled(secondHandle, 'new-turn')
  expect(journal.stopMarks.latest()?.settle).toMatchObject({ settling: false, turnId: 'new-turn' })
  const thirdHandle = journal.stopMarks.beginSettle(true)
  await journal.replaceEpochItems('handle_forked', 1, items)
  journal.stopMarks.settled(secondHandle, 'stale-turn')
  expect(journal.stopMarks.latest()?.settle?.settling).toBe(true)
  journal.stopMarks.settled(thirdHandle, 'final-turn')
  expect(journal.stopMarks.latest()?.settle).toMatchObject({
    settling: false,
    turnId: 'final-turn'
  })
  await journal.appendSubmission({
    clientMessageId: 'after',
    body,
    payloadFingerprint: 'b'.repeat(64),
    fence: 1
  })
  const key = agentJournalSubmissionKey('after')
  for (const keys of [captured, during!]) {
    expect(keys.has(agentJournalSubmissionKey('before'))).toBe(true)
    expect(keys.has(key)).toBe(false)
    expect(keys.changes.get(key)).toBe(false)
  }
  expect(aborted.changes.has(key)).toBe(false)
  lifetime.abort()
  duringLifetime.abort()
  await journal.appendSubmission({
    clientMessageId: 'after-abort',
    body,
    payloadFingerprint: 'c'.repeat(64),
    fence: 1
  })
  expect(captured.changes.has(agentJournalSubmissionKey('after-abort'))).toBe(false)
  expect(during!.changes.has(agentJournalSubmissionKey('after-abort'))).toBe(false)
  expect(await retained).toEqual(before)
  const published = journal.snapshot()
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  const reopened = await journals.open({ stateDirectory: root, identity })
  expect(reopened.snapshot()).toEqual(published)
})

it('discards speculative capture state on rollback while retaining real settlement during preparation', async () => {
  const { journal } = await fixture()
  await journal.appendStopEvent({ reason: 'user-stop' }, 1)
  const handle = journal.stopMarks.beginSettle(true)
  const before = structuredClone(journal.snapshot())
  const lifetime = new AbortController()
  let during: ReturnType<typeof journal.inputOrder.captureKeys> | undefined
  await expect(
    journal.replaceEpochItems('handle_forked', 1, items, () => ({
      write: async () => {
        during = journal.inputOrder.captureKeys(new Set(), lifetime.signal)
        journal.stopMarks.settled(handle, 'settled-during-preparation')
        await new Promise<void>((resolve) => setImmediate(resolve))
        throw new Error('replacement rollback')
      },
      committed: () => {
        throw new Error('must not settle rollback')
      }
    }))
  ).rejects.toThrow('replacement rollback')
  expect(journal.snapshot()).toEqual(before)
  expect(journal.stopMarks.latest()?.settle).toMatchObject({
    settling: false,
    turnId: 'settled-during-preparation'
  })
  await journal.appendSubmission({
    clientMessageId: 'after-rollback',
    body,
    payloadFingerprint: 'd'.repeat(64),
    fence: 1
  })
  expect(during!.has(agentJournalSubmissionKey('after-rollback'))).toBe(false)
  expect(during!.changes.get(agentJournalSubmissionKey('after-rollback'))).toBe(false)
  lifetime.abort()
  await journal.replaceEpochItems('handle_forked', 1, items)
  expect(journal.itemBody(agentJournalSubmissionKey('new'))).toEqual({
    kind: 'status',
    text: 'new'
  })
})

it('adopts and notifies a known COMMIT despite a failing mandatory receipt, and cold reopens it', async () => {
  const { journal } = await fixture()
  const notify = vi.fn()
  journal.observeCommits(notify)
  await expect(
    journal.replaceEpochItems('handle_forked', 1, items, () => ({
      write: () => {},
      committed: () => {
        throw new Error('receipt settlement failed')
      }
    }))
  ).rejects.toBeInstanceOf(JournalCommittedEffectError)
  expect(notify).toHaveBeenCalledOnce()
  expect(journal.itemBody(agentJournalSubmissionKey('old'))).toBeNull()
  expect(journal.itemBody(agentJournalSubmissionKey('new'))).toEqual({
    kind: 'status',
    text: 'new'
  })
  expect(journal.submission('before')?.dispatchState).toBe('pending')
  const published = journal.snapshot()
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  const reopened = await journals.open({ stateDirectory: root, identity })
  expect(reopened.snapshot()).toEqual(published)
  await reopened.appendSubmission({
    clientMessageId: 'after-commit',
    body,
    payloadFingerprint: 'e'.repeat(64),
    fence: 1
  })
  expect(reopened.submission('after-commit')?.dispatchState).toBe('pending')
})
