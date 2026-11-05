import { afterEach, expect, it, vi } from 'vitest'
import { OmpRpcSessionAdapter } from './rpc-session-adapter'
import { FakeConnection, state } from '../pi/rpc-session-adapter.test-fixture'
import { OMP_RPC_AGENT } from './rpc-agent-definition'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  CALLER,
  attachParams,
  envelope,
  hostTestState,
  replaceHostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'

let adapter: OmpRpcSessionAdapter | undefined
afterEach(async () => {
  await adapter?.closeAll()
  await adapter?.drainObservedExits()
})

it('refreshes selected model controls through the resting host without sending a message', async () => {
  const original = hostTestState()
  const models = [
    {
      provider: 's2time-openai',
      id: 'gpt-6.1-sol',
      api: 'openai-responses',
      reasoning: true,
      identity: { class: 'openai' }
    },
    {
      provider: 's2time-openai',
      id: 'gpt-6-astra',
      api: 'openai-responses',
      reasoning: true,
      identity: { class: 'openai' }
    }
  ]
  let model = models[0]
  let connection: FakeConnection | undefined
  const hostEvents: Promise<void>[] = []
  let host: StructuredAgentSessionHost
  adapter = new OmpRpcSessionAdapter({
    resolveLaunch: async () => ({
      command: 'omp',
      cwd: original.root,
      fullAccess: true,
      previous: null
    }),
    readProcessStartTime: async () => 12345,
    openConnection: (_launch, handlers) => {
      connection = new FakeConnection(handlers)
      const request = connection.request.bind(connection)
      connection.request = async (command, params) => {
        if (command === 'set_model') {
          model = models.find((entry) => entry.id === params?.modelId)!
          return model
        }
        if (command === 'get_available_models') {
          return { models }
        }
        if (command === 'get_state') {
          return {
            ...state,
            model,
            thinkingLevel: 'high',
            fastModeEnabled: false,
            fastModeActive: false
          }
        }
        return request(command, params)
      }
      return Object.assign(connection, {
        thinkingLevels: async () =>
          model.id === 'gpt-6.1-sol' ? ['low', 'high'] : ['high', 'xhigh']
      })
    },
    onLifecycle: (event) => {
      hostEvents.push(host.handleAdapterEvent(event))
    },
    onSettled: () => {},
    logger: original.log.logger
  })
  const agents = new StructuredAgentRegistry([{ definition: OMP_RPC_AGENT, adapter }])
  const router = new StructuredAgentSessionAdapterRouter(agents, () => adapter!.closeAll())
  host = new StructuredAgentSessionHost({ ...original.host.deps, agents, adapter: router })
  replaceHostTestState({ host, store: original.store })
  expect(
    await host.attach(
      CALLER,
      attachParams({
        provider: 'omp',
        agent: 'omp',
        providerHandle: undefined,
        accountHome: { variable: 'PI_CODING_AGENT_DIR', path: original.root }
      })
    )
  ).toMatchObject({ ok: true })
  await vi.waitFor(async () => {
    expect((await host.readOptions(SESSION)).models[0]?.efforts).toEqual([
      { value: 'low', label: 'low' },
      { value: 'high', label: 'high' }
    ])
  })
  const key = 'model'
  const value = 's2time-openai/gpt-6-astra'
  expect(
    await host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', { key, value }),
      key,
      value
    })
  ).toMatchObject({ ok: true })
  expect(await host.readOptions(SESSION)).toMatchObject({
    current: { model: 's2time-openai/gpt-6-astra', effort: 'high' },
    fastModeSupport: { supported: true },
    models: expect.arrayContaining([
      expect.objectContaining({
        id: 's2time-openai/gpt-6-astra',
        supportsFastMode: true,
        efforts: [
          { value: 'high', label: 'high' },
          { value: 'xhigh', label: 'xhigh' }
        ]
      })
    ])
  })
  expect(connection?.sent).toEqual([])
  await Promise.all(hostEvents)
})
