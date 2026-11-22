import { z } from 'zod'
import { afterEach, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { KIRO_LAUNCH_SPEC } from '../../kiro/kiro-acp-launch-spec'
import { openAcpAdapterRig, PROVIDER_SESSION } from './testing/acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

it('keeps an unsupported Kiro effort from reaching the model, then admits a supported retry', async () => {
  const effortOption = {
    id: 'effortLevel',
    name: 'Effort',
    type: 'select',
    category: 'thought_level',
    currentValue: 'medium',
    options: ['low', 'medium', 'high'].map((value) => ({ value, name: value }))
  }
  const rig = await openAcpAdapterRig({
    spec: KIRO_LAUNCH_SPEC,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: [effortOption] })
      )
      agent.on('session/set_config_option', (frame) => {
        const currentValue =
          z.object({ value: z.string() }).parse(frame.params).value === 'low' ? 'low' : 'medium'
        agent.reply(frame, { configOptions: [{ ...effortOption, currentValue }] })
      })
    }
  })
  await rig.acquire()
  const send = (effort: string) =>
    rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: effort,
      fence: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      executionOptions: { effort }
    })
  await expect(send('max')).rejects.toThrow('Kiro could not apply reasoning effort')
  await expect(send('high')).rejects.toThrow('Kiro could not apply reasoning effort')
  expect(rig.sent('session/prompt')).toEqual([])
  await expect(send('low')).resolves.toEqual({ state: 'admitted' })
  await rig.frame('session/prompt')
  expect(rig.sent('session/set_config_option').at(-1)?.params).toMatchObject({ value: 'low' })
})
