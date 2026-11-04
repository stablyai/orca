import { JournalOutcomeSweeper } from '../../native-chat/agent-session-journal/journal-outcome-cleanup'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { agentSessionAttachmentStoreRoot } from '../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger'
import * as attachmentSweeps from '../../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  seedTestOutcomeSweepPopulation
} from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionRecordStore } from './records/agent-session-record-store'
import {
  installAgentSessionAttachments,
  stopAgentSessionAttachments
} from './structured-agent-session-attachment-wiring'

let stateDirectory: string

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-attachment-wiring-'))
})

afterEach(async () => {
  stopAgentSessionAttachments()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(stateDirectory, { recursive: true, force: true })
})

const records: Pick<AgentSessionRecordStore, 'getRecord' | 'isSessionUnreadable'> = {
  getRecord: () => null,
  isSessionUnreadable: () => false
}

function install(directory = stateDirectory): void {
  // Written by a newer Orca: the sweeps read no claims, so nothing here touches the connection.
  const journal: Parameters<typeof installAgentSessionAttachments>[0]['journalDatabase'] = {
    read: () => {
      throw new Error('not opened in this test')
    },
    scan: () => {
      throw new Error('not opened in this test')
    },
    transaction: () => {
      throw new Error('not opened in this test')
    },
    maintenance: () => {
      throw new Error('not opened in this test')
    },
    readOnly: true,
    isClosed: false
  }
  installAgentSessionAttachments({
    stateDirectory: directory,
    store: records,
    journalDatabase: journal,
    logger: createStructuredAgentSessionLogger()
  })
}

describe('installAgentSessionAttachments', () => {
  // Claude takes the store as an added directory only if it exists when Claude starts.
  it('creates the store root the Claude launch is granted, before any upload', () => {
    install()
    const root = agentSessionAttachmentStoreRoot(stateDirectory)
    expect(existsSync(root)).toBe(true)
    expect(getAgentSessionAttachmentStore()?.rootDir).toBe(root)
  })

  it('still installs the store when the root cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A file where the state directory should be: nothing can be created under it.
    const blocked = join(stateDirectory, 'not-a-directory')
    await writeFile(blocked, '')
    expect(() => install(blocked)).not.toThrow()
    expect(getAgentSessionAttachmentStore()?.rootDir).toBe(agentSessionAttachmentStoreRoot(blocked))
    warn.mockRestore()
  })

  it("starts the chat database's sweep of retired records and stops it with the attachments", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(attachmentSweeps, 'startAgentSessionAttachmentSweeps').mockReturnValue({
      stop: () => undefined
    })
    const database = await openTestJournalHostDatabase(stateDirectory)
    const retire = () => seedTestOutcomeSweepPopulation(database, 0, 'gone-epoch', 1)
    const pass = JournalOutcomeSweeper.prototype.pass
    const passes = vi.spyOn(JournalOutcomeSweeper.prototype, 'pass').mockImplementation(function (
      this: JournalOutcomeSweeper
    ) {
      // Native page pacing must run on real timers after the launch timer fires.
      vi.useRealTimers()
      return pass.call(this)
    })
    const retired = async () =>
      (
        await database.read((read) =>
          read.prepare('SELECT COUNT(*) AS n FROM journal_outcome_generations').get()
        )
      )?.n
    await retire()
    installAgentSessionAttachments({
      stateDirectory,
      store: records,
      journalDatabase: database,
      logger: createStructuredAgentSessionLogger()
    })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(await retired()).toBe(1)
    // The first pass a minute after launch: the records page, a rest, then the generation row.
    await vi.advanceTimersByTimeAsync(1_000)
    await passes.mock.results[0]!.value
    expect(await retired()).toBe(0)
    await retire()
    stopAgentSessionAttachments()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
    expect(await retired()).toBe(1)
  })
})
