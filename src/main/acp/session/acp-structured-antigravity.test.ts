import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import fixture from '../fixtures/antigravity-v1.4.1-options.json'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { openAcpAdapterRig, PROVIDER_SESSION } from './testing/acp-structured-adapter.test-support'

const ANTIGRAVITY = acpLaunchSpecFor('antigravity')!
afterEach(closeProviderTimelineRigs)

it('writes xhigh and max thinking_level options and switches native Antigravity models', async () => {
  const nativeConfigOptions = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: 'claude-opus-5-5',
      options: [
        { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' }
      ]
    },
    {
      id: 'thinking_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select' as const,
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra high' },
        { value: 'max', name: 'Max' }
      ]
    },
    fixture.session.configOptions[2]!
  ]
  let currentModel = 'claude-opus-5-5'
  let currentThinking = 'high'
  const snapshot = () =>
    nativeConfigOptions.map((option) =>
      option.id === 'model'
        ? { ...option, currentValue: currentModel }
        : option.id === 'thinking_level'
          ? { ...option, currentValue: currentThinking }
          : option
    )

  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY.hostBackend!.spec,
    initialize: fixture.initialize,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: snapshot() })
      )
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = z
          .object({ configId: z.string(), value: z.string() })
          .parse(frame.params)
        if (configId === 'model') {
          currentModel = value
        } else if (configId === 'thinking_level') {
          currentThinking = value
        }
        agent.reply(frame, { configOptions: snapshot() })
      })
    }
  })

  await rig.acquire()
  await rig.adapter.dispatch({
    sessionId: SESSION,
    clientMessageId: 'xhigh-send',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
    executionOptions: { model: 'gemini-4-hydrogen', effort: 'xhigh' }
  })
  const firstPrompt = await rig.frame('session/prompt')
  expect(rig.sent('session/set_config_option').map(({ params }) => params)).toEqual([
    { sessionId: PROVIDER_SESSION, configId: 'mode', value: 'default' },
    { sessionId: PROVIDER_SESSION, configId: 'model', value: 'gemini-4-hydrogen' },
    { sessionId: PROVIDER_SESSION, configId: 'thinking_level', value: 'xhigh' }
  ])
  rig.child().agent.reply(firstPrompt, { stopReason: 'end_turn' })
  await rig.settle()

  await rig.adapter.setOption({ sessionId: SESSION, fence: 1, key: 'effort', value: 'max' })
  expect(rig.sent('session/set_config_option').at(-1)?.params).toEqual({
    sessionId: PROVIDER_SESSION,
    configId: 'thinking_level',
    value: 'max'
  })
})
