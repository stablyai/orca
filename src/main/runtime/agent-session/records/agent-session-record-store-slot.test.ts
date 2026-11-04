/** Early launch admission and the later chat host must share one record-store writer. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'
import { openAgentSessionRecordStoreOnce } from './agent-session-record-store-slot'
import { stopStructuredAgentSessionRuntime } from '../structured-agent-session-runtime'

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
