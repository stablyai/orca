import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { openAcpAdapterRig } from './acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

const DATA = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
const withImage: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [
    { type: 'image-ref', url: `data:image/png;base64,${DATA}` },
    { type: 'text', text: 'what is this?' }
  ]
}

describe('ACP image prompts', () => {
  it('sends an image to an agent whose row offers images and whose start advertised them', async () => {
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode')!,
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
  })

  it('refuses the message, sending nothing, when the agent did not advertise images', async () => {
    const rig = await openAcpAdapterRig({ spec: acpLaunchSpecFor('opencode')! })
    await rig.acquire()
    await expect(
      rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'm1', body: withImage, fence: 1 })
    ).resolves.toMatchObject({ state: 'rejected', rejection: { kind: 'attachmentInvalid' } })
    expect(rig.sent('session/prompt')).toEqual([])
  })

  it('refuses an image for an agent whose row offers none, whatever it advertises', async () => {
    const rig = await openAcpAdapterRig({
      initialize: { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }
    })
    await rig.acquire()
    await expect(
      rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'm1', body: withImage, fence: 1 })
    ).resolves.toMatchObject({ state: 'rejected' })
    expect(rig.sent('session/prompt')).toEqual([])
  })
})
