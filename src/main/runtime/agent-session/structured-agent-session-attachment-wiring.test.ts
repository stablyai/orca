import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { agentSessionAttachmentStoreRoot } from '../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { closeTestJournalHostDatabases } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { openTestAgentSessionDatabase } from './records/agent-session-record-store-test-harness'
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

async function install(directory = stateDirectory): Promise<void> {
  const journal = await openTestAgentSessionDatabase(stateDirectory)
  installAgentSessionAttachments({
    stateDirectory: directory,
    store: records,
    journalDatabase: journal,
    logger: createStructuredAgentSessionLogger()
  })
}

describe('installAgentSessionAttachments', () => {
  // Claude takes the store as an added directory only if it exists when Claude starts.
  it('creates the store root the Claude launch is granted, before any upload', async () => {
    await install()
    const root = agentSessionAttachmentStoreRoot(stateDirectory)
    expect(existsSync(root)).toBe(true)
    expect(getAgentSessionAttachmentStore()?.rootDir).toBe(root)
  })

  it('still installs the store when the root cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A file where the state directory should be: nothing can be created under it.
    const blocked = join(stateDirectory, 'not-a-directory')
    await writeFile(blocked, '')
    await expect(install(blocked)).resolves.toBeUndefined()
    expect(getAgentSessionAttachmentStore()?.rootDir).toBe(agentSessionAttachmentStoreRoot(blocked))
    warn.mockRestore()
  })
})
