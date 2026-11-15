import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { createTrackedJournalOpener } from '../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { openTestAgentSessionDatabase } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { isAgentSessionAttachmentExpiredError } from './agent-session-attachment-claims'
import {
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot
} from './agent-session-attachment-references'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const UPLOAD_A = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
const UPLOAD_B = '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02'

function message(...blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

describe('agentSessionAttachmentReferences', () => {
  const root = '/srv/orca/agent-session-attachments'

  it("leaves a mention of any other store path as text: another server's, a ~ form, a bare name", () => {
    const mentions = [
      `@/home/other/agent-session-attachments/${UPLOAD_A}/a.txt`,
      `~/Library/Application Support/Orca/agent-session-attachments/${UPLOAD_A}/x.png`,
      `see agent-session-attachments/${UPLOAD_A}`,
      `/mnt${root}/${UPLOAD_A}/a.txt`
    ]
    for (const text of mentions) {
      expect(
        agentSessionAttachmentReferences(root, message({ type: 'text', text }), 'linux')
      ).toEqual(new Set())
    }
  })

  it('matches a Windows store with either separator and in any case', () => {
    const windowsRoot = 'C:\\Users\\me\\AppData\\Roaming\\orca\\agent-session-attachments'
    const references = agentSessionAttachmentReferences(
      windowsRoot,
      message(
        {
          type: 'image-ref',
          path: `c:/users/ME/appdata/roaming/orca/agent-session-attachments/${UPLOAD_A}/s.png`
        },
        { type: 'text', text: `@"${windowsRoot}\\${UPLOAD_B.toUpperCase()}\\a b.txt"` }
      ),
      'win32'
    )
    expect([...references].sort()).toEqual([UPLOAD_A, UPLOAD_B].sort())
  })
})

describe('claims written with the message', () => {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-c',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: claudeProviderHandle('native-1', null)
  }
  let stateDirectory: string
  let storeRoot: string
  let clock = 1_000
  const journals = createTrackedJournalOpener()

  function open(sessionId = IDENTITY.sessionId): Promise<AgentSessionJournal> {
    return journals.open({
      identity: { ...IDENTITY, sessionId },
      stateDirectory,
      now: () => ++clock,
      mintEpoch: () => `epoch-${clock}`
    })
  }

  async function storeUpload(uploadId: string, name = 'shot.png'): Promise<string> {
    await mkdir(join(storeRoot, uploadId), { recursive: true })
    await writeFile(join(storeRoot, uploadId, name), 'bytes')
    return join(storeRoot, uploadId, name)
  }

  async function claims(): Promise<{ uploadId: string; sessionId: string }[]> {
    const database = await openTestAgentSessionDatabase(stateDirectory)
    const result = await database.readers.database({ kind: 'attachment-claims', after: 0 })
    if (result.kind !== 'attachment-claims') {
      throw new Error('expected attachment claims')
    }
    return result.claims.map(({ uploadId, sessionId }) => ({ uploadId, sessionId }))
  }

  function clientSend(journal: AgentSessionJournal, id: string, body: AgentJournalMessageItem) {
    return journal.appendSubmission({
      clientMessageId: id,
      payloadFingerprint: `fp-${id}`,
      body,
      fence: 0,
      origin: 'client'
    })
  }

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-attachment-claims-'))
    storeRoot = agentSessionAttachmentStoreRoot(stateDirectory)
    clock = 1_000
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(stateDirectory, { recursive: true, force: true })
  })

  it('refuses the whole client message, writing nothing, when an upload is gone', async () => {
    const journal = await open()
    const error = await clientSend(
      journal,
      'send-1',
      message(
        { type: 'text', text: 'see the image' },
        { type: 'image-ref', path: join(storeRoot, UPLOAD_A, 'shot.png') }
      )
    ).catch((caught: unknown) => caught)
    expect(isAgentSessionAttachmentExpiredError(error)).toBe(true)
    expect(await journal.reads.submission('send-1')).toBeUndefined()
    expect(await claims()).toEqual([])
  })

  it("refuses a gone upload and keeps a waiting card's attachment claim across clear", async () => {
    const journal = await open()
    const missing = message({ type: 'text', text: `@${join(storeRoot, UPLOAD_B, 'a.txt')}` })
    const refused = await journal.queuedMessages
      .insert({
        messageId: 'draft-0',
        body: missing,
        requireAttachments: true
      })
      .catch((caught: unknown) => caught)
    expect(isAgentSessionAttachmentExpiredError(refused)).toBe(true)
    expect(await journal.queuedMessages.list()).toHaveLength(0)

    const path = await storeUpload(UPLOAD_A, 'notes.txt')
    const body = message({ type: 'text', text: `read @${path}` })
    await journal.queuedMessages.insert({
      messageId: 'draft-1',
      body,
      requireAttachments: true
    })
    await journal.write({
      kind: 'context-clear',
      boundary: { operationId: 'clear', afterFence: 0, clearedAt: 1000 }
    })
    await journals.closeAll()
    const reopened = await open()
    expect(await reopened.queuedMessages.get('draft-1')).toMatchObject({ body, state: 'waiting' })
    expect(await claims()).toEqual([{ uploadId: UPLOAD_A, sessionId: IDENTITY.sessionId }])
  })
})
