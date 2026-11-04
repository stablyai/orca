/** Early launch admission and the later chat host must share one record-store writer. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  openAgentSessionRecordStoreOnce,
  peekOpenedAgentSessionRecordStore,
  releaseAgentSessionRecordStore
} from './agent-session-record-store-slot'
import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from '../structured-agent-session-runtime'

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

describe('the record store slot', () => {
  it('hands every caller the same store', async () => {
    const [first, second] = await Promise.all([
      openAgentSessionRecordStoreOnce(location()),
      openAgentSessionRecordStoreOnce(location())
    ])

    expect(second.store).toBe(first.store)
  })

  it('builds a chat host installed after admission on the store admission opened', async () => {
    const { store } = await openAgentSessionRecordStoreOnce(location())
    const close = vi.spyOn(JournalHostDatabase.prototype, 'close')

    const host = await ensureStructuredAgentSessionHost({
      ...location(),
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => []
    })
    expect(host.deps.store).toBe(store)

    await stopStructuredAgentSessionRuntime()
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a store no chat host was built on when the runtime stops', async () => {
    const { store } = await openAgentSessionRecordStoreOnce(location())
    const close = vi.spyOn(JournalHostDatabase.prototype, 'close')

    await stopStructuredAgentSessionRuntime()

    expect(close).toHaveBeenCalledOnce()
    const reopened = await openAgentSessionRecordStoreOnce(location())
    expect(reopened.store).not.toBe(store)
  })

  it('refuses a second profile rather than opening a second store', async () => {
    await openAgentSessionRecordStoreOnce(location())
    const elsewhere = await mkdtemp(join(tmpdir(), 'orca-record-store-slot-other-'))
    try {
      await expect(openAgentSessionRecordStoreOnce(location(elsewhere))).rejects.toThrow(
        'agent_session_record_store_location_changed'
      )
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('lets the next caller retry after an open fails', async () => {
    const notADirectory = join(stateDirectory, 'profile-file')
    await writeFile(notADirectory, 'not a profile')

    await expect(openAgentSessionRecordStoreOnce(location(notADirectory))).rejects.toThrow()
    await expect(openAgentSessionRecordStoreOnce(location())).resolves.toMatchObject({
      store: expect.anything()
    })
  })
})

it('publishes source installation and release even when opening an empty record store', async () => {
  const observed: unknown[] = []
  const facets: string[][] = []
  const stop = sessionCrewChanges.subscribe((changed) => {
    observed.push(peekOpenedAgentSessionRecordStore())
    facets.push([...changed].sort())
  })
  try {
    const first = await openAgentSessionRecordStoreOnce(location())
    expect(observed).toEqual([first.store])
    await openAgentSessionRecordStoreOnce(location())
    expect(observed).toEqual([first.store])
    const released = await releaseAgentSessionRecordStore()
    expect(observed).toEqual([first.store, null])
    expect(facets).toEqual([
      ['records', 'topology'],
      ['records', 'topology']
    ])
    released?.journalDatabase.close()
  } finally {
    stop()
  }
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
