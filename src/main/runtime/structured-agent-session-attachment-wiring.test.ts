import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { agentSessionAttachmentStoreRoot } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type Database from '../sqlite/sync-database'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { AgentSessionRecordStore } from './agent-session-record-store'
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
  await rm(stateDirectory, { recursive: true, force: true })
})

function install(directory = stateDirectory): void {
  const records: Pick<AgentSessionRecordStore, 'getRecord' | 'isSessionUnreadable'> = {
    getRecord: () => null,
    isSessionUnreadable: () => false
  }
  // Written by a newer Orca: the sweep reads no claims, so nothing here touches the connection.
  const journal: Pick<JournalHostDatabase, 'readOnly' | 'isClosed' | 'db'> = {
    readOnly: true,
    isClosed: false,
    get db(): Database.Database {
      throw new Error('not opened in this test')
    }
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
})
