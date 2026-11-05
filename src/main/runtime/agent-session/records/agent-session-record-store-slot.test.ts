import '../../../native-chat/agent-session-journal/journal-host-database-test-support'
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

it.each(['standalone', 'construction'] as const)(
  'retains failed %s database closure for retry',
  async (path) => {
    const { AgentSessionRecordStore } = await import('./agent-session-record-store')
    let database: JournalHostDatabase | undefined
    const realClose = JournalHostDatabase.prototype.close
    const realOpen = JournalHostDatabase.open
    vi.spyOn(JournalHostDatabase, 'open').mockImplementation(async (directory) => {
      const opened = await realOpen(directory)
      database = opened
      return opened
    })
    const close = vi
      .spyOn(JournalHostDatabase.prototype, 'close')
      .mockRejectedValueOnce(new Error('close failed'))
    if (path === 'construction') {
      vi.spyOn(AgentSessionRecordStore, 'open').mockImplementationOnce(() => {
        throw new Error('construction failed')
      })
      await expect(openAgentSessionRecordStoreOnce(location())).rejects.toThrow('close failed')
    } else {
      await openAgentSessionRecordStoreOnce(location())
      await expect(stopStructuredAgentSessionRuntime()).rejects.toThrow('close failed')
    }
    expect(database?.isClosed).toBe(false)
    close.mockImplementation(realClose)
    const retiring = database
    // A new admission must first finish retiring the old connection.
    await openAgentSessionRecordStoreOnce(location())
    expect(retiring?.isClosed).toBe(true)
  }
)
