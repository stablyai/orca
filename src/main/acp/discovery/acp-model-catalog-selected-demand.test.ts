import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { expect, it, vi, onTestFinished } from 'vitest'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { NewSessionResponseSchema } from '../generated/acp-protocol.generated'
import { createAcpModelCatalogProbe } from './acp-model-catalog-probe'
import type { AcpModelCatalogSessionConnection } from './acp-listing-session-models'
import { AgentModelCatalogStore } from '../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogService } from '../../native-chat/agent-model-catalog/agent-model-catalog-service'

it('starts the first OMP listing on demand collected before admission, without a second session', async () => {
  const base = acpLaunchSpecFor('omp')!
  const connect = vi.fn((launch: ProviderProcessLaunch): AcpModelCatalogSessionConnection => {
    const modelAt = launch.args.indexOf('--model')
    const current = modelAt !== -1 ? launch.args[modelAt + 1] : 'provider/default'
    return {
      initialize: async () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { delete: {} } }
      }),
      start: async () => ({
        kind: 'new',
        sessionId: 'listing',
        response: NewSessionResponseSchema.parse({
          sessionId: 'listing',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: current,
              options: [
                { value: 'provider/default', name: 'Default' },
                { value: 'provider/selected', name: 'Selected' }
              ]
            },
            {
              id: 'thinking',
              name: 'Thinking',
              category: 'thought_level',
              type: 'select',
              currentValue: 'high',
              options: [{ value: 'high', name: 'High' }]
            }
          ]
        })
      }),
      setConfigOption: async () => {
        throw new Error('OMP selects on launch')
      },
      deleteSession: async () => ({}),
      close: async () => {}
    }
  })
  const probe = createAcpModelCatalogProbe(
    {
      ...base,
      account: { ...base.account, environment: (_home, env) => env },
      modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false }
    },
    {
      resolveEnvironment: async () => ({}),
      resolveCommand: () => process.execPath,
      probeVersion: async () => ({ version: '18.0.0' }),
      homePath: '/account',
      dataDirectory: '/unused',
      connectSession: connect
    }
  )
  const store = new AgentModelCatalogStore()
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => undefined,
    getConversation: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'PI_CODING_AGENT_DIR', path: '/account' }),
    probes: { omp: probe }
  })
  onTestFinished(() => service.stop())
  const result = await service.read({
    agent: 'omp',
    workspacePath: '/workspace',
    selectedModel: 'provider/selected',
    waitForListing: true
  })
  if (result.origin === 'unknown') {
    throw new Error('Expected the selected model inventory')
  }
  expect(result.models?.find((row) => row.id === 'provider/selected')).toMatchObject({
    efforts: [{ value: 'high', label: 'High' }]
  })
  expect(connect).toHaveBeenCalledOnce()
  expect(connect.mock.calls[0]?.[0].args).toEqual(['acp', '--model', 'provider/selected'])
})
