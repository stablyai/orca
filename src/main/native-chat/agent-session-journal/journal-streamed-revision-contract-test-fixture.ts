import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { journalPragmaNumber } from './journal-database'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { formatNativeChatFileReference } from '../../../shared/agent-image-paste'
import * as attachmentReferences from '../agent-session-attachments/agent-session-attachment-references'

export const journals = createTrackedJournalOpener({ legacyInputs: true })

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-streamed-revision-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

export const text = (role: 'assistant' | 'user', value: string): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text: value }]
})

export function openJournal(sessionId = 'stream') {
  return journals.open({
    stateDirectory: root,
    identity: {
      sessionId,
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'grok',
      providerHandle: null
    }
  })
}

export function commitLevels() {
  const { db } = openTestJournalHostDatabase(root)
  const levels: number[] = []
  const exec = db.exec.bind(db)
  vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      levels.push(journalPragmaNumber(db, 'synchronous'))
    }
    exec(sql)
  })
  return levels
}

export async function uploadedInput() {
  const id = randomUUID()
  const path = join(attachmentReferences.agentSessionAttachmentStoreRoot(root), id, 'source.txt')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'retained input')
  return { id, body: text('user', formatNativeChatFileReference(path)) }
}

export const fixture = {
  get root() {
    return root
  },
  set root(value: typeof root) {
    root = value
  }
}
