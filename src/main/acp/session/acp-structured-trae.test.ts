import { afterEach, describe, expect, it } from 'vitest'
import { TRAE_LAUNCH_SPEC } from '../../trae/trae-acp-launch-spec'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import { TRAE_ACP_DIALECT } from '../acp-dialects/trae-dialect'
import { acpLaunchInstructions } from '../launch/acp-instructions'
import {
  closeProviderTimelineRigs,
  messageText
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpAdapterRig, PROVIDER_SESSION } from './testing/acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

describe('TRAE conversation adoption', () => {
  it('sends the native MAX model identifier instead of the lossy configuration family', () => {
    const options = new AcpStructuredOptions(TRAE_ACP_DIALECT)
    options.adoptSession(
      {
        models: {
          currentModelId: 'gpt-6.1-sol/max/xhigh',
          availableModels: [{ modelId: 'gpt-6.1-sol/max/xhigh', name: 'GPT-6.1-Sol (xhigh, max)' }]
        },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gpt-6.1-sol',
            options: [{ value: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }]
          },
          {
            id: 'reasoning_effort',
            name: 'Reasoning',
            category: 'thought_level',
            type: 'select',
            currentValue: 'xhigh',
            options: [{ value: 'xhigh', name: 'Xhigh' }]
          }
        ]
      },
      'loaded'
    )
    expect(options.read().current).toEqual({ model: 'gpt-6.1-sol/max/xhigh', confirmed: ['model'] })
    expect(options.write('model', 'gpt-6.1-sol/max/xhigh')).toEqual({
      method: 'model',
      modelId: 'gpt-6.1-sol/max/xhigh'
    })
  })
  it('retains messages around oversized old tool output and sends the standing instructions on load', async () => {
    const instructions = await acpLaunchInstructions(TRAE_LAUNCH_SPEC, '/unused', {
      sessionId: 'orca-trae-history',
      text: 'Keep this workspace scoped to the requested task.',
      env: {},
      cwd: '/workspace/project',
      version: '0.216.0'
    })
    const rig = await openAcpAdapterRig({
      spec: TRAE_LAUNCH_SPEC,
      launch: {
        ...instructions,
        resume: {
          sessionId: PROVIDER_SESSION,
          key: 'acp:trae:saved',
          mayBeUnsaved: async () => false,
          lossKeys: []
        }
      },
      initialize: { agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } },
      script: (agent) => {
        agent.on('session/load', (frame) => {
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Opening recorded reply.' }
            }
          })
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'user_message_chunk',
              messageId: 'saved-user-message',
              content: { type: 'text', text: 'Read the saved result.' }
            }
          })
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'saved-tool-call',
              title: 'Read archived output',
              kind: 'read',
              status: 'completed',
              rawInput: { path: 'archived.log' },
              rawOutput: 'x'.repeat(17 * 1024 * 1024)
            }
          })
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Recovered final answer.' }
            }
          })
          agent.reply(frame, { configOptions: [] })
        })
      }
    })
    await rig.acquire({ permissionMode: 'own' })
    expect(rig.openFailure()).toBeUndefined()
    expect((await rig.frame('session/load')).params).toMatchObject({
      cwd: '/workspace/project',
      sessionId: 'acp-session-1',
      systemPrompt: {
        mode: 'append',
        content: [{ type: 'text', text: 'Keep this workspace scoped to the requested task.' }]
      }
    })
    const texts = (await rig.rig.rows()).flatMap((row) => messageText(row.body) ?? [])
    expect(texts).toEqual([
      'Read the saved result.',
      'Opening recorded reply.',
      'Recovered final answer.'
    ])
  })
})
