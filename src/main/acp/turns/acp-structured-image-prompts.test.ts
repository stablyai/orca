import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  type AcpAdapterRig
} from '../session/testing/acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

const DATA = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
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
