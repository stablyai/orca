import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { formatNativeChatFileReference } from '../../../shared/agent-image-paste'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isAgentSessionAttachmentExpiredError,
  markUnclaimedUploadForSweep
} from './agent-session-attachment-claims'
import {
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot
} from './agent-session-attachment-references'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const UPLOAD_A = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
const UPLOAD_B = '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02'

function message(...blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

describe('agentSessionAttachmentReferences', () => {
  const root = '/srv/orca/agent-session-attachments'

  it('finds image paths and file references in text, however the reference is quoted', () => {
    const quoted = formatNativeChatFileReference(`${root}/${UPLOAD_B}/my "notes" and 'more'.txt`)
    const references = agentSessionAttachmentReferences(
      root,
      message(
        { type: 'image-ref', path: `${root}/${UPLOAD_A}/shot.png` },
        { type: 'text', text: `read ${quoted} please` }
      ),
      'linux'
    )
    expect([...references].sort()).toEqual([UPLOAD_A, UPLOAD_B].sort())
  })

  it("leaves a mention of any other store path as text: another server's, a ~ form, a bare name", () => {
    const mentions = [
      `@/home/other/agent-session-attachments/${UPLOAD_A}/a.txt`,
      `~/Library/Application Support/Orca/agent-session-attachments/${UPLOAD_A}/x.png`,
      `see agent-session-attachments/${UPLOAD_A}`,
      // This host's root as the tail of a longer path is still another path.
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

  function claims(): { upload_id: string; session_id: string }[] {
    return openTestJournalHostDatabase(stateDirectory)
      .db.prepare(
        'SELECT upload_id, session_id FROM agent_session_attachment_claims ORDER BY session_id'
      )
      .all()
      .flatMap((row) =>
        typeof row === 'object' &&
        row !== null &&
        'upload_id' in row &&
        'session_id' in row &&
        typeof row.upload_id === 'string' &&
        typeof row.session_id === 'string'
          ? [{ upload_id: row.upload_id, session_id: row.session_id }]
          : []
      )
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

  it("claims a client message's stored uploads in the same write", async () => {
    const journal = await open()
    const path = await storeUpload(UPLOAD_A)
    await clientSend(journal, 'send-1', message({ type: 'image-ref', path }))
    expect(journal.submission('send-1')).toBeTruthy()
    expect(claims()).toEqual([{ upload_id: UPLOAD_A, session_id: IDENTITY.sessionId }])
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
    expect(journal.submission('send-1')).toBeUndefined()
    expect(claims()).toEqual([])
  })

  it('refuses an upload the sweep already marked, even while its file is still on disk', async () => {
    const journal = await open()
    const path = await storeUpload(UPLOAD_A)
    expect(
      markUnclaimedUploadForSweep(openTestJournalHostDatabase(stateDirectory).db, UPLOAD_A, 1)
    ).toBe(true)
    const error = await clientSend(journal, 'send-1', message({ type: 'image-ref', path })).catch(
      (caught: unknown) => caught
    )
    expect(isAgentSessionAttachmentExpiredError(error)).toBe(true)
  })

  it('a claim landing first keeps the sweep from marking the upload', async () => {
    const journal = await open()
    const path = await storeUpload(UPLOAD_A)
    await clientSend(journal, 'send-1', message({ type: 'image-ref', path }))
    expect(
      markUnclaimedUploadForSweep(openTestJournalHostDatabase(stateDirectory).db, UPLOAD_A, 1)
    ).toBe(false)
  })

  it("never refuses the host's own message, and claims what it names", async () => {
    const journal = await open()
    const path = await storeUpload(UPLOAD_A)
    await journal.appendSubmission({
      clientMessageId: 'host-1',
      payloadFingerprint: 'fp',
      body: message(
        { type: 'image-ref', path },
        { type: 'image-ref', path: join(storeRoot, UPLOAD_B, 'gone.png') }
      ),
      fence: 0,
      origin: 'host'
    })
    expect(journal.submission('host-1')).toBeTruthy()
    expect(
      claims()
        .map((claim) => claim.upload_id)
        .sort()
    ).toEqual([UPLOAD_A, UPLOAD_B].sort())
  })

  it("refuses a gone upload and keeps a waiting card's attachment claim across clear", async () => {
    const journal = await open()
    const missing = message({ type: 'text', text: `@${join(storeRoot, UPLOAD_B, 'a.txt')}` })
    const refused = await journal.queuedMessages
      .insert({
        messageId: 'draft-0',
        body: missing,
        fingerprint: 'fp',
        hostInstance: 'p',
        requireAttachments: true
      })
      .catch((caught: unknown) => caught)
    expect(isAgentSessionAttachmentExpiredError(refused)).toBe(true)
    expect(journal.queuedMessages.list()).toHaveLength(0)

    const path = await storeUpload(UPLOAD_A, 'notes.txt')
    const body = message({ type: 'text', text: `read @${path}` })
    await journal.queuedMessages.insert({
      messageId: 'draft-1',
      body,
      fingerprint: 'fp',
      hostInstance: 'p',
      requireAttachments: true
    })
    await journal.context.clear(
      { operationId: 'clear', afterFence: 0, clearedAt: 1000 },
      { write: () => {}, committed: () => {} },
      'caller-clear'
    )
    await journals.closeAll()
    const reopened = await open()
    expect(reopened.queuedMessages.get('draft-1')).toMatchObject({ body, carriedFrom: null })
    expect(claims()).toEqual([{ upload_id: UPLOAD_A, session_id: IDENTITY.sessionId }])
  })

  it("does not refuse a draft's conversion: the draft claimed its uploads when it was written", async () => {
    const journal = await open()
    const path = await storeUpload(UPLOAD_A, 'notes.txt')
    const body = message({ type: 'text', text: `read @${path}` })
    await journal.queuedMessages.insert({
      messageId: 'draft-1',
      body,
      fingerprint: 'fp',
      hostInstance: 'p',
      requireAttachments: true
    })
    await rm(join(storeRoot, UPLOAD_A), { recursive: true })
    await journal.appendSubmission(
      { clientMessageId: 'handoff-1', payloadFingerprint: 'fp', body, fence: 0, origin: 'client' },
      { messageId: 'draft-1', expect: 'waiting', settledByOp: null }
    )
    expect(journal.submission('handoff-1')).toBeTruthy()
  })

  it('keeps its claims across a host restart', async () => {
    let journal = await open()
    const path = await storeUpload(UPLOAD_A)
    await clientSend(journal, 'send-1', message({ type: 'image-ref', path }))
    await journals.closeAll()
    journal = await open()
    expect(claims()).toEqual([{ upload_id: UPLOAD_A, session_id: IDENTITY.sessionId }])
    expect(
      markUnclaimedUploadForSweep(openTestJournalHostDatabase(stateDirectory).db, UPLOAD_A, 1)
    ).toBe(false)
  })
})
