import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  it.each(['opencode', 'omp'])(
    'sends an image to %s when its start advertises images',
    async (agent) => {
      const rig = await openAcpAdapterRig({
        spec: acpLaunchSpecFor(agent)!,
        initialize: {
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }
        }
      })
      await rig.acquire()
      await expect(
        rig.adapter.dispatch({
          sessionId: SESSION,
          clientMessageId: 'm1',
          body: withImage,
          fence: 1
        })
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
    }
  )

  it.each([
    ['opencode', undefined],
    ['opencode', false],
    ['omp', undefined],
    ['omp', false]
  ] as const)('refuses images when %s advertises image=%s', async (agent, image) => {
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor(agent)!,
      initialize: { agentCapabilities: { loadSession: true, promptCapabilities: { image } } }
    })
    await rig.acquire()
    await expect(
      rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'm1', body: withImage, fence: 1 })
    ).resolves.toMatchObject({ state: 'rejected', rejection: { kind: 'attachmentInvalid' } })
    expect(rig.sent('session/prompt')).toEqual([])
    await expect(acceptsImages(rig)).resolves.toBe(false)
  })

  it('delivers multiple OMP images from a host file and inline data without losing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-omp-images-'))
    const path = join(root, 'attachment.png')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=',
      'base64'
    )
    try {
      await writeFile(path, png)
      const rig = await openAcpAdapterRig({
        spec: acpLaunchSpecFor('omp')!,
        initialize: {
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }
        }
      })
      await rig.acquire()
      await expect(
        rig.adapter.dispatch({
          sessionId: SESSION,
          clientMessageId: 'm1',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [
              { type: 'image-ref', path },
              { type: 'text', text: 'compare these' },
              { type: 'image-ref', url: `data:image/png;base64,${png.toString('base64')}` }
            ]
          },
          fence: 1
        })
      ).resolves.toEqual({ state: 'admitted' })
      expect((await rig.frame('session/prompt')).params).toMatchObject({
        prompt: [
          { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
          { type: 'text', text: 'compare these' },
          { type: 'image', mimeType: 'image/png', data: png.toString('base64') }
        ]
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
    await expect(acceptsImages(rig)).resolves.toBe(false)
  })
})
