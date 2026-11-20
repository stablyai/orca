import { expect, it, vi } from 'vitest'
import type { AgentImageFitRequest } from '../../../agent-images/agent-image-fit-protocol'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { preparePiRpcPrompt, PiRpcPromptError } from '../../../../pi/rpc/prompts/rpc-prompt'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

const fitting = vi.hoisted(() => ({ enabled: false, pasteFolder: '' }))
vi.mock('../../../paste-files/native-chat-paste-files', () => ({
  nativeChatPasteFolder: () => fitting.pasteFolder,
  isInsideNativeChatPasteFolder: () => false
}))
vi.mock('../../../../worker-threads/worker-thread-request-queue', () => ({
  WorkerThreadRequestQueue: class {
    async retired() {}
    async dispatch(build: (id: number) => AgentImageFitRequest) {
      const request = build(1)
      const { prepareAgentImageFile } = await import('../../../agent-images/agent-image-fit')
      const result = fitting.enabled
        ? await prepareAgentImageFile(request.path, request.outputDirectory)
        : { path: request.path }
      return { id: request.id, ok: true, ...result }
    }
  }
}))

it('sends an old returned image card through fitting without editing its stored message', async () => {
  fitting.enabled = false
  const rig = await createQueuedMessageTestRig({ restartable: true })
  fitting.pasteFolder = rig.root
  try {
    const source = join(rig.root, 'retina.png')
    const original = Buffer.concat([
      PNG.sync.write(new PNG({ width: 2400, height: 1600 })),
      Buffer.alloc(6 * 1024 * 1024)
    ])
    await writeFile(source, original)
    const opener = await rig.workingSend()
    await rig.settleAccepted(opener, 'opening')
    await openRigTurnFor(rig, opener)
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Keep this screenshot and these words' },
        { type: 'image-ref', path: source }
      ]
    }
    const id = hostTestOperationId()
    const fields = { body, delivery: 'queue-if-active' as const }
    expect(
      await rig.host.send(CALLER, {
        ...fields,
        userSend: true,
        envelope: rig.envelope(fields, 'agentSession.send', id)
      })
    ).toMatchObject({ ok: true })
    await expect(preparePiRpcPrompt(body, false)).rejects.toBeInstanceOf(PiRpcPromptError)
    expect(await rig.sendNow(id)).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.handoff(id))?.handedOverAt).toBeDefined())
    const refused = await rig.handoff(id)
    await rig.settleRejected(
      refused!.clientMessageId,
      'An image on this message is larger than 5 MB'
    )
    await eventually(async () =>
      expect(await rig.drafts()).toContainEqual({ messageId: id, state: 'returned' })
    )
    fitting.enabled = true
    rig.dispatch.mockImplementation(async ({ body }) => {
      await preparePiRpcPrompt(body, false)
      return { state: 'admitted' }
    })
    expect(await rig.sendNow(id)).toMatchObject({ ok: true })
    await eventually(async () => {
      const handoff = await rig.handoff(id)
      expect(handoff).toBeDefined()
      expect(rig.dispatch.mock.calls.at(-1)?.[0].body.blocks).toEqual([
        { type: 'text', text: 'Keep this screenshot and these words' },
        { type: 'image-ref', path: expect.stringMatching(/agent-images/) },
        {
          type: 'text',
          text: expect.stringContaining(
            `Image source file: ${JSON.stringify(source)}; attached viewing copy:`
          )
        }
      ])
    })
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect((await journal.queuedMessages.get(id))?.body).toEqual(body)
    expect((await readFile(source)).equals(original)).toBe(true)
  } finally {
    await rig.dispose()
  }
})
