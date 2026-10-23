import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { openAcpAdapterRig, type AcpAdapterRig } from './acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

const DATA = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
// What the chat's options report says, by the same rule as the send.
function acceptsImages(rig: AcpAdapterRig) {
  return rig.adapter
    .readOptions({ sessionId: SESSION, fence: 1 })
    .then((read) => read.acceptsImages)
}

const withImage: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [
    { type: 'image-ref', url: `data:image/png;base64,${DATA}` },
    { type: 'text', text: 'what is this?' }
  ]
}

describe('ACP image prompts', () => {
  it('sends an image to an agent whose start advertised them', async () => {
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('omp')!,
      initialize: { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }
    })
    await rig.acquire()
    await expect(
      rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'm1', body: withImage, fence: 1 })
    ).resolves.toEqual({ state: 'admitted' })
    expect((await rig.frame('session/prompt')).params).toMatchObject({
      prompt: [
        { type: 'image', mimeType: 'image/png', data: DATA },
        { type: 'text', text: 'what is this?' }
      ]
    })
    await expect(acceptsImages(rig)).resolves.toBe(true)
    // The start's answer, not a second handshake.
    expect(rig.sent('initialize')).toHaveLength(1)
  })

  it('refuses an image with no saved file, sending nothing, when the agent did not advertise images', async () => {
    const rig = await openAcpAdapterRig({ spec: acpLaunchSpecFor('opencode')! })
    await rig.acquire()
    await expect(
      rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'm1', body: withImage, fence: 1 })
    ).resolves.toMatchObject({ state: 'rejected', rejection: { kind: 'attachmentInvalid' } })
    expect(rig.sent('session/prompt')).toEqual([])
    await expect(acceptsImages(rig)).resolves.toBe(false)
  })
})
