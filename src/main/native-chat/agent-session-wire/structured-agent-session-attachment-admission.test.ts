// A message naming a chat attachment the host no longer stores is refused whole at admission,
// with a reason the client's existing rejected-send row puts into words, on the direct path and
// the queued one alike; a stored one is claimed, and a /clear carries the claim to its new chat.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
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

function claimedSessions(): string[] {
  return openTestJournalHostDatabase(rig.root)
    .db.prepare('SELECT session_id FROM agent_session_attachment_claims ORDER BY session_id')
    .all()
    .flatMap((row) =>
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

  it('refuses a queued send naming an expired file, and queues nothing', async () => {
    await rig.workingSend()
    expect(await clientSend(textWith(storedPath('notes.txt')), 'queue-if-active')).toMatchObject(
      EXPIRED
    )
    expect(await rig.drafts()).toHaveLength(0)
  })

  it('claims a stored upload, and the /clear carry claims it for the replacement chat', async () => {
    const working = await rig.workingSend()
    const path = await storeUpload('notes.txt')
    expect(await clientSend(textWith(path), 'queue-if-active')).toMatchObject({
      ok: true,
      value: { queued: { state: 'waiting' } }
    })
    expect(claimedSessions()).toEqual([SESSION])
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    const fields = { command: 'clear' as const }
    const cleared = await rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    expect(replacementId).toBeTruthy()
    expect(claimedSessions()).toEqual([SESSION, replacementId].sort())
  })

  it('sends text that only mentions another store path, claiming nothing', async () => {
    const result = await clientSend(
      textWith(`/home/someone/.config/Orca/agent-session-attachments/${UPLOAD}/notes.txt`)
    )
    expect(result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    expect(claimedSessions()).toEqual([])
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
    // The upload goes; the outbox's resend of the same operation still answers as sent.
    await rm(join(agentSessionAttachmentStoreRoot(rig.root), UPLOAD), { recursive: true })
    expect(await rig.host.send(CALLER, params)).toMatchObject({ ok: true, replayed: true })
  })

  it("never refuses a host-side send (orchestration mail, a restart's continuation)", async () => {
    const body = textWith(storedPath('notes.txt'))
    const clientOperationId = hostTestOperationId()
    const result = await rig.host.send(CALLER, {
      envelope: rig.envelope({ body }, 'agentSession.send', clientOperationId),
      body
    })
    expect(result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
  })
})
