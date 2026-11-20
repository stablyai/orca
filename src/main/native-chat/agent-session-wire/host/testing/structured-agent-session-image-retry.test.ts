import { expect, it, vi } from 'vitest'
import type * as ImageFitClient from '../../../agent-images/agent-image-fit-client'
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
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { preparePiRpcPrompt, PiRpcPromptError } from '../../../../pi/rpc/prompts/rpc-prompt'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

const fitting = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../agent-images/agent-image-fit-client', async (importOriginal) => {
  const original = await importOriginal<typeof ImageFitClient>()
  const { fitAgentImageFile } = await import('../../../agent-images/agent-image-fit')
  const { dirname, join } = await import('node:path')
  return {
    ...original,
    fitAgentMessageImages: async (body: AgentJournalMessageItem) => ({
      ...body,
      blocks: await Promise.all(
        body.blocks.map(async (block) =>
          fitting.enabled && block.type === 'image-ref' && block.path
            ? {
                ...block,
                path: await fitAgentImageFile(block.path, join(dirname(block.path), 'fitted'))
              }
            : block
        )
      )
    })
  }
})

it('sends an old returned image card through fitting without editing its stored message', async () => {
  fitting.enabled = false
  const rig = await createQueuedMessageTestRig({ restartable: true })
  try {
    const source = join(rig.root, 'retina.png')
    const original = Buffer.concat([
      PNG.sync.write(new PNG({ width: 2400, height: 1600 })),
      Buffer.alloc(6 * 1024 * 1024)
    ])
    await writeFile(source, original)
    rig.dispatch.mockImplementation(async ({ body }) => {
      try {
        await preparePiRpcPrompt(body, false)
        return { state: 'admitted' }
      } catch (error) {
        if (!(error instanceof PiRpcPromptError)) {
          throw error
        }
        return {
          state: 'rejected',
          ...agentSessionFailureWords(error.failure, { surface: 'rejection' })
        }
      }
    })
    await rig.workingSend()
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
    expect(await rig.sendNow(id)).toMatchObject({ ok: true })
    await eventually(async () =>
      expect(
        (await rig.drafts()).some((draft) => draft.messageId === id && draft.state === 'returned')
      ).toBe(true)
    )
    fitting.enabled = true
    expect(await rig.sendNow(id)).toMatchObject({ ok: true })
    await eventually(async () => {
      const handoff = await rig.handoff(id)
      expect(handoff).toBeDefined()
      expect(rig.dispatch.mock.calls.at(-1)?.[0].body.blocks).toEqual([
        { type: 'text', text: 'Keep this screenshot and these words' },
        { type: 'image-ref', path: expect.stringMatching(/fitted/) }
      ])
    })
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect((await journal.queuedMessages.get(id))?.body).toEqual(body)
    expect((await readFile(source)).equals(original)).toBe(true)
  } finally {
    await rig.dispose()
  }
})
