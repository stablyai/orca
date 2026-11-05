import '../../../native-chat/agent-session-journal/journal-host-database-test-support'
/** Early launch admission and the later chat host must share one record-store writer. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  journalDatabasePath,
  JournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database'
import { JournalSqlOwner } from '../../../native-chat/agent-session-journal/journal-sql-owner'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  hasPersistedStructuredAgentSessionStore,
  openAgentSessionRecordStoreOnce
} from './agent-session-record-store-slot'
import { stopStructuredAgentSessionRuntime } from '../structured-agent-session-runtime'
import {
  ensureStructuredAgentSessionHostUnlessRefused,
  recordStructuredAgentSessionHostInstallRefusal,
  structuredAgentSessionHostRefusal
} from '../structured-agent-session-host-refusal'

const HOST_ID = 'local'
let stateDirectory: string

function location(directory = stateDirectory) {
  return {
    stateDirectory: directory,
    legacySessionTabIds: [],
    hostId: HOST_ID,
    logger: createStructuredAgentSessionLogger()
  }
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-record-store-slot-'))
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  recordStructuredAgentSessionHostInstallRefusal(null)
  vi.restoreAllMocks()
  await rm(stateDirectory, { recursive: true, force: true })
})

it('retains failed standalone database closure for retry', async () => {
  const { journalDatabase } = await openAgentSessionRecordStoreOnce(location())
  const realClose = JournalHostDatabase.prototype.close
  const close = vi
    .spyOn(JournalHostDatabase.prototype, 'close')
    .mockRejectedValueOnce(new Error('close failed'))
  await expect(stopStructuredAgentSessionRuntime()).rejects.toThrow('close failed')
  expect(journalDatabase.isClosed).toBe(false)
  close.mockImplementation(realClose)
  await openAgentSessionRecordStoreOnce(location())
  expect(journalDatabase.isClosed).toBe(true)
})

it('keeps terminal journal admission independent of provider record construction', async () => {
  const { openSurfaceJournalOnce } =
    await import('../../../workspace-surfaces/surface-journal-slot')
  const { AgentSessionRecordStore } = await import('./agent-session-record-store')
  const journal = await openSurfaceJournalOnce(location())
  vi.spyOn(AgentSessionRecordStore, 'open').mockImplementationOnce(() => {
    throw new Error('construction failed')
  })
  await expect(openAgentSessionRecordStoreOnce(location())).rejects.toThrow('construction failed')
  expect(journal.isClosed).toBe(false)
  expect(await openSurfaceJournalOnce(location())).toBe(journal)
  const records = await openAgentSessionRecordStoreOnce(location())
  expect(records.journalDatabase).toBe(journal)
  await stopStructuredAgentSessionRuntime()
  expect(journal.isClosed).toBe(true)
})

it('finishes a pre-open existence reader before restoring the shared writable journal', async () => {
  await openAgentSessionRecordStoreOnce(location())
  await stopStructuredAgentSessionRuntime()
  const closing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const close = JournalSqlOwner.prototype.close
  vi.spyOn(JournalSqlOwner.prototype, 'close').mockImplementationOnce(async function (
    this: JournalSqlOwner
  ) {
    closing.resolve()
    await release.promise
    await close.call(this)
  })
  const present = hasPersistedStructuredAgentSessionStore(stateDirectory)
  await closing.promise
  const restored = openAgentSessionRecordStoreOnce(location())
  try {
    release.resolve()
    expect(await present).toBe(false)
    const { journalDatabase } = await restored
    expect(await hasPersistedStructuredAgentSessionStore(stateDirectory)).toBe(false)
    expect(await journalDatabase.read((read) => read.prepare('PRAGMA journal_mode').get())).toEqual(
      { journal_mode: 'wal' }
    )
    expect(await openAgentSessionRecordStoreOnce(location())).toEqual(await restored)
  } finally {
    release.resolve()
    await restored
  }
})

it('records the normal unreadable refusal after a concurrent probe closes and keeps non-chat work available', async () => {
  const bytes = Buffer.from('not a database '.repeat(512))
  await writeFile(journalDatabasePath(stateDirectory), bytes)
  recordStructuredAgentSessionHostInstallRefusal(null)
  const closing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const close = JournalSqlOwner.prototype.close
  const open = vi.mocked(JournalHostDatabase.open).getMockImplementation()
  if (!open) {
    throw new Error('Native journal worker fixture is unavailable')
  }
  let probeClosed = false
  vi.spyOn(JournalSqlOwner.prototype, 'close').mockImplementationOnce(async function (
    this: JournalSqlOwner
  ) {
    closing.resolve()
    await release.promise
    await close.call(this)
    probeClosed = true
  })
  vi.spyOn(JournalHostDatabase, 'open').mockImplementation((...args) => {
    expect(probeClosed).toBe(true)
    return open(...args)
  })
  const present = hasPersistedStructuredAgentSessionStore(stateDirectory)
  await closing.promise
  const opening = openAgentSessionRecordStoreOnce(location())
  const nonChat = ensureStructuredAgentSessionHostUnlessRefused(() => opening).catch(
    (error: unknown) => error
  )
  try {
    release.resolve()
    expect(await present).toBe(true)
    expect(await nonChat).toBeUndefined()
    expect(structuredAgentSessionHostRefusal()?.refusal).toMatchObject({
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    })
    expect(await readFile(journalDatabasePath(stateDirectory))).toEqual(bytes)
  } finally {
    release.resolve()
    await opening.catch(() => undefined)
  }
})
