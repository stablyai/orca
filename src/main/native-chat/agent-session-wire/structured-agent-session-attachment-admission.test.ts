// Direct/queued admission rejects missing attachments atomically; stored claims survive clear migration.

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

const UPLOAD = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
const EXPIRED = {
  ok: false,
  refusal: { code: 'agent_session_operation_invalid', details: { reason: 'attachmentExpired' } }
}

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function storedPath(name: string): string {
  return join(agentSessionAttachmentStoreRoot(rig.root), UPLOAD, name)
}

async function storeUpload(name: string): Promise<string> {
  await mkdir(join(agentSessionAttachmentStoreRoot(rig.root), UPLOAD), { recursive: true })
  await writeFile(storedPath(name), 'bytes')
  return storedPath(name)
}

function clientSend(body: AgentJournalMessageItem, delivery?: 'queue-if-active') {
  const clientOperationId = hostTestOperationId()
  const fields = { body, ...(delivery ? { delivery } : {}) }
  return rig.host.send(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.send', clientOperationId),
    body,
    ...(delivery ? { delivery } : {}),
    userSend: true
  })
}

async function claimedSessions(): Promise<string[]> {
  return (
    await (
      await openTestJournalHostDatabase(rig.root)
    ).read((read) =>
      read
        .prepare('SELECT session_id FROM agent_session_attachment_claims ORDER BY session_id')
        .all()
    )
  ).flatMap((row) =>
    typeof row === 'object' && row !== null && 'session_id' in row ? [String(row.session_id)] : []
  )
}

function textWith(path: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `read @${path}` }] }
}

describe('attachments at send admission', () => {
  it('refuses a send naming an expired image before anything is recorded', async () => {
    const result = await clientSend({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'image-ref', path: storedPath('shot.png') }]
    })
    expect(result).toMatchObject(EXPIRED)
    expect((await rig.host.journalSnapshot(SESSION)).submissions).toHaveLength(0)
    expect(rig.dispatch).not.toHaveBeenCalled()
  })

  it('names only the expired upload when a fresh one is sent beside it', async () => {
    const fresh = await storeUpload('fresh.png')
    const expiredUpload = '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02'
    const expired = join(agentSessionAttachmentStoreRoot(rig.root), expiredUpload, 'old photo.png')
    const result = await clientSend({
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'image-ref', path: fresh },
        { type: 'image-ref', path: expired }
      ]
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: {
          reason: 'attachmentExpired',
          expiredAttachments: [{ uploadId: expiredUpload, name: 'old photo.png' }]
        }
      }
    })
    expect((await rig.host.journalSnapshot(SESSION)).submissions).toHaveLength(0)
    expect(await claimedSessions()).toEqual([])
    expect(existsSync(fresh)).toBe(true)
  })

  it('sends text that only mentions another store path, claiming nothing', async () => {
    const result = await clientSend(
      textWith(`/home/someone/.config/Orca/agent-session-attachments/${UPLOAD}/notes.txt`)
    )
    expect(result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    expect(await claimedSessions()).toEqual([])
  })

  it('replays an admitted send under the same id without judging its attachments again', async () => {
    const path = await storeUpload('shot.png')
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'image-ref', path }]
    }
    const clientOperationId = hostTestOperationId()
    const params = {
      envelope: rig.envelope({ body }, 'agentSession.send', clientOperationId),
      body,
      userSend: true as const
    }
    expect(await rig.host.send(CALLER, params)).toMatchObject({ ok: true, replayed: false })
    // Lost replies must replay acceptance even after upload deletion.
    await rm(join(agentSessionAttachmentStoreRoot(rig.root), UPLOAD), { recursive: true })
    expect(await rig.host.send(CALLER, params)).toMatchObject({ ok: true, replayed: true })
  })
})
