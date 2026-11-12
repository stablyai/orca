import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAcpStructuredLaunchResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { agentSessionRecordFixture } from '../../native-chat/agent-session-record-test-fixture'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { acpLaunchSpecFor } from './acp-launch-registry'

vi.mock('../../native-chat/native-chat-visuals-skill-location', () => ({
  resolveNativeChatVisualsSkillLocation: async () => ({
    pluginDir: join('/installed', 'native-chat-visuals'),
    skillsRoot: join('/installed', 'native-chat-visuals', 'skills')
  })
}))

it.each([false, true])(
  'loads OMP telemetry with visuals disabled (saved conversation: %s)',
  async (saved) => {
    const handle = { transport: 'acp', agent: 'omp', nativeId: 'saved-omp' }
    const record = agentSessionRecordFixture({
      sessionId: 'omp-chat',
      provider: 'omp',
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/isolated/omp' },
      options: { model: 'custom/gpt-4.1' },
      providerHandleChain: saved
        ? [
            {
              linkId: 'saved',
              handle,
              origin: 'adopted',
              mintedAtFence: 1,
              observedAt: 1
            }
          ]
        : []
    })
    const resolved = await createAcpStructuredLaunchResolver(acpLaunchSpecFor('omp')!, {
      store: { getRecord: () => record, pinLaunchDirectory: async () => record },
      resolveCommand: () => '/installed/omp',
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      prepareVisuals: async () => null,
      probeVersion: async () => ({ version: '18.19.0' }),
      readJournal: () => null
    })({
      identity: {
        sessionId: 'omp-chat',
        workspaceId: 'workspace-1',
        hostId: LOCAL_EXECUTION_HOST_ID,
        agent: 'omp',
        providerHandle: saved ? handle : null
      }
    })
    expect(resolved.args).toEqual([
      'acp',
      '--extension',
      join('/installed', 'native-chat-visuals', 'omp-native-chat.mjs'),
      ...(saved ? [] : ['--model', 'custom/gpt-4.1'])
    ])
    expect(resolved.resume?.sessionId).toBe(saved ? 'saved-omp' : undefined)
  }
)
