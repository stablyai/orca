import '../unused-default-rpc-methods.test-fixture'
/** A new workspace's held message with an image, a file reference and a skill, released whole to
 *  the launch prepared for it: its files reach the host's store under that live launch before any
 *  chat exists, and the ordinary founding admits the complete message with their claims. */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { acceptedDispatch } from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { agentSessionAttachmentStoreRoot } from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { agentSessionAttachmentUploadIdOfPath } from '../../../../shared/agent-session/agent-session-attachments'
import { openTestAgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store-test-harness'
import { CAPABLE_CLIENT, setAgentLaunchRecordStore } from './agent-launch.test-fixture'

const createStructured = vi.hoisted(() => vi.fn((): Promise<unknown> => new Promise(() => {})))
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructured
}))

const {
  DESKTOP,
  FIRST_MESSAGE,
  MESSAGE_ID,
  claimedUploads,
  operationId,
  prepare,
  prepared,
  realChatHost,
  release,
  status,
  storedUploads,
  untilAwaitingRelease,
  uploadUnder
} = await import('./agent-launch-release.test-fixture')
const { noteStructuredAgentSessionClose } =
  await import('./structured-agent-session-close-before-create')

let directory: string

/** The real host whose production create founds the released chat. */
async function foundingChatHost() {
  const host = await realChatHost()
  createStructured.mockImplementationOnce(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch hands the real create its real arguments; the mock's narrow type covers only the stubbed cases.
    host.create as unknown as Parameters<typeof createStructured.mockImplementationOnce>[0]
  )
  return host
}

function noEffect(runtime: { createTerminal: unknown }): void {
  expect(createStructured).not.toHaveBeenCalled()
  expect(runtime.createTerminal).not.toHaveBeenCalled()
}

beforeEach(async () => {
  createStructured.mockClear()
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-rich-'))
  setAgentLaunchRecordStore(await openTestAgentSessionRecordStore(directory))
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('a held message with files, released whole', () => {
  it('stores its files under the prepared launch with no chat yet, then founds the whole message', async () => {
    const host = await foundingChatHost()
    try {
      const id = operationId()
      await prepare(host.runtime, prepared(id, { agent: 'codex', sessionId: host.sessionId }))
      await untilAwaitingRelease(host.runtime, id)
      const under = { sessionId: host.sessionId, launchOperationId: id }
      const image = await (await uploadUnder(host, under, 'shot.png', 'png-bytes')).commit()
      const notes = await (await uploadUnder(host, under, 'notes.txt', 'line one')).commit()
      expect(host.rig.store.getRecord(host.sessionId)).toBeNull()
      expect(await readFile(image, 'utf8')).toBe('png-bytes')
      const body = {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: `fix this with $audit, see @${notes}` },
          { type: 'image-ref', path: image }
        ],
        skills: [{ name: 'audit', path: '/skills/audit/SKILL.md' }]
      }
      let claimedAtDispatch: string[] = []
      host.rig.adapter.dispatch.mockImplementationOnce(async () => {
        claimedAtDispatch = claimedUploads(host.rig.root, host.sessionId)
        return acceptedDispatch()
      })
      await release(host.runtime, id, {
        options: {},
        selection: {},
        firstMessage: { clientMessageId: MESSAGE_ID, body }
      })
      await vi.waitFor(() => expect(host.rig.adapter.dispatch).toHaveBeenCalledOnce())
      expect(host.rig.adapter.dispatch.mock.calls[0]?.[0]).toMatchObject({
        clientMessageId: MESSAGE_ID,
        body
      })
      expect(claimedAtDispatch).toEqual(
        [image, notes].map((path) => agentSessionAttachmentUploadIdOfPath(path)).sort()
      )
      await expect(status(host.runtime, id, { waitMs: 5_000 })).resolves.toMatchObject({
        state: 'succeeded',
        result: { prompt: { outcome: 'journaled', messageId: MESSAGE_ID } }
      })
    } finally {
      await host.dispose()
    }
  })

  it('admits none of a message naming a file never stored, and answers its retry the same', async () => {
    const host = await foundingChatHost()
    try {
      const id = operationId()
      await prepare(
        host.runtime,
        prepared(id, {
          agent: 'codex',
          sessionId: host.sessionId,
          terminalAlternative: { kind: 'none' }
        })
      )
      await untilAwaitingRelease(host.runtime, id)
      const missing = join(agentSessionAttachmentStoreRoot(host.rig.root), randomUUID(), 'a.png')
      const input = {
        options: {},
        selection: {},
        firstMessage: {
          clientMessageId: MESSAGE_ID,
          body: { ...FIRST_MESSAGE.body, blocks: [{ type: 'image-ref', path: missing }] }
        }
      }
      await release(host.runtime, id, input)
      // Refused whole before any chat, message or claim: a typed failure, not an unknown outcome.
      const settled = await status(host.runtime, id, { waitMs: 5_000 })
      expect(settled).toEqual({
        state: 'failed',
        code: 'agent_launch_attachment_expired',
        message:
          'A chat attachment in this message is no longer stored on the host, so it was not sent.'
      })
      await expect(release(host.runtime, id, input)).resolves.toEqual({
        operationId: id,
        ...settled
      })
      expect(host.rig.adapter.dispatch).not.toHaveBeenCalled()
      expect(host.rig.store.getRecord(host.sessionId)).toBeNull()
      expect(claimedUploads(host.rig.root, host.sessionId)).toEqual([])
    } finally {
      await host.dispose()
    }
  })

  it('stores nothing for another chat, caller or launch, and drops a part when its launch ends', async () => {
    const host = await realChatHost()
    try {
      const id = operationId()
      await prepare(host.runtime, prepared(id, { agent: 'codex', sessionId: host.sessionId }))
      await untilAwaitingRelease(host.runtime, id)
      const other = 'codex_9b1deb4d_3b7d_4bad_9bdd_000000000000'
      for (const [start, caller] of [
        [{ sessionId: other, launchOperationId: id }, DESKTOP],
        [{ sessionId: host.sessionId, launchOperationId: id }, CAPABLE_CLIENT],
        [{ sessionId: host.sessionId, launchOperationId: operationId(9) }, DESKTOP],
        // Without the launch it is an ordinary upload, which needs the chat on this host.
        [{ sessionId: host.sessionId }, DESKTOP]
      ] as const) {
        await expect(uploadUnder(host, start, 'a.png', 'x', caller)).rejects.toThrow()
      }
      expect(await storedUploads(host)).toEqual([])
      const partial = await uploadUnder(
        host,
        { sessionId: host.sessionId, launchOperationId: id },
        'b.png',
        'bytes'
      )
      noteStructuredAgentSessionClose(host.sessionId, false)
      await vi.waitFor(() =>
        expect(host.attachments.isUploadInFlight(partial.uploadId)).toBe(false)
      )
      await expect(partial.commit()).rejects.toThrow()
      await vi.waitFor(async () => expect(await storedUploads(host)).toEqual([]))
      await expect(
        uploadUnder(host, { sessionId: host.sessionId, launchOperationId: id }, 'c.png', 'x')
      ).rejects.toThrow('This chat is not on this host')
      noEffect(host.runtime)
    } finally {
      await host.dispose()
    }
  })
})
