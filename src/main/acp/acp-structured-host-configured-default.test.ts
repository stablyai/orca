import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../shared/agent-session-wire'
import { structuredAgentSessionSeedCatalog } from '../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from '../native-chat/agent-model-catalog/agent-project-model-override'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { createAcpModelCatalogProbe } from './acp-model-catalog-probe'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import { AcpSessionRuntime } from './acp-session-runtime'
import { GROK, GROK_CONFIG_OPTIONS } from './acp-structured-adapter.test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { createTestParams } from '../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import type { StructuredAgentSessionFirstMessage } from '../../shared/structured-agent-session-create'
import { attachParams, launch, openHostRig } from './acp-structured-host.test-support'

const GROK_HOME = { variable: 'GROK_HOME', path: '/grok' }
const EFFORT_META = {
  supportsReasoningEffort: true,
  reasoningEfforts: [
    { id: 'high', value: 'high', default: true },
    { id: 'low', value: 'low' }
  ]
}

const agents: AcpScriptedAgent[] = []
afterEach(async () => {
  for (const agent of agents.splice(0)) {
    agent.close()
  }
  await closeProviderTimelineRigs()
})

/** Grok's `initialize` with no session: it computes 4.7 as its current model. */
function grokProbe() {
  return createAcpModelCatalogProbe(GROK, {
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    dataDirectory: '/orca-data',
    resolveCommand: () => '/opt/grok/bin/grok',
    homePath: '/home/user',
    connect: () => {
      const agent = new AcpScriptedAgent()
      agents.push(agent)
      agent.on('initialize', (frame) =>
        agent.reply(frame, {
          protocolVersion: 1,
          agentCapabilities: {},
          _meta: {
            modelState: {
              currentModelId: 'grok-4.7',
              availableModels: [
                { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: EFFORT_META },
                { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: EFFORT_META }
              ]
            }
          }
        })
      )
      const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin)
      return {
        initialize: () => runtime.initialize(),
        requestSessionFreeExtension: (method, params) =>
          runtime.requestSessionFreeExtension(method, params),
        close: async () => runtime.close()
      }
    }
  })
}

/** What a new Grok chat's composer paints first from a host answer. */
function firstFrame(answer: AgentSessionModelCatalogResult) {
  const seed = structuredAgentSessionSeedCatalog('grok')
  const state = applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('grok', seed),
    seed,
    answer,
    { newLaunch: true }
  )
  const snapshot = structuredAgentSessionOptionSnapshot(state)
  expect(state.record).toEqual({ agent: 'grok', valuesByModel: {} })
  const select = (id: string) => {
    const entry = snapshot.find((descriptor) => descriptor.id === id)
    return entry?.kind.type === 'select' ? (entry.kind.currentValue ?? null) : null
  }
  return { model: select('model'), effort: select('effort') }
}

/** The host's listing, then a Grok chat opened with no model pick whose own session runs `runs`;
 *  `create` founds it with its first message, so only delivery starts the agent. */
async function openGrokHost(runs: string, create?: StructuredAgentSessionFirstMessage) {
  const records: { store: AgentSessionRecordStore | null } = { store: null }
  let processScope: () => string | null = () => null
  const discovery = GROK.modelDiscovery
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getRecord: (sessionId) => records.store?.getRecord(sessionId) ?? undefined,
    drivesRecord: () => true,
    processScope: () => processScope(),
    resolveAccountHome: async () => GROK_HOME,
    recordWorkspacePath: async () => '/workspace/project',
    agentReadsProjectModelConfig,
    workspaceMayOverrideDefaultModel,
    probes: { grok: grokProbe() },
    // As the launch spec says, not by hand.
    listingNamesConfiguredModel: new Set(
      discovery.kind !== 'unavailable' && discovery.listingNamesConfiguredModel ? ['grok'] : []
    )
  })
  const opened = GROK_CONFIG_OPTIONS.map((option) =>
    option.id === 'model' ? { ...option, currentValue: runs } : option
  )
  const rig = await openHostRig({
    modelCatalog: catalog,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: 'acp-session-1', configOptions: opened })
      )
      agent.on('session/set_config_option', (frame) =>
        agent.reply(frame, {
          configOptions: opened.map((option) =>
            option.id === 'model' ? { ...option, currentValue: 'grok-4.7' } : option
          )
        })
      )
    },
    deps: { resolveLaunch: launch(() => false) }
  })
  records.store = rig.store
  processScope = () => rig.host.modelCatalogProcessScope(SESSION)
  const listed = await catalog.read({ agent: 'grok', waitForListing: true })
  const opening = create
    ? rig.host.create(CALLER, createTestParams(create, attachParams()), { firstMessage: create })
    : rig.host.attach(CALLER, attachParams())
  expect(await opening).toMatchObject({ ok: true })
  return { ...rig, catalog, listed }
}

describe('Grok process model authority', () => {
  it('names no configured model from a session-free listing', async () => {
    const { listed } = await openGrokHost('grok-4.6')
    expect(listed).toMatchObject({ origin: 'probe', listingNamesConfiguredModel: false })
    expect(firstFrame(listed)).toEqual({ model: null, effort: null })
  })

  it('reports the owning process model rather than initialize currentModelId', async () => {
    const { host, catalog } = await openGrokHost('grok-4.6')
    expect((await host.readOptions(SESSION)).current).toMatchObject({ model: 'grok-4.6' })
    const nextComposer = () =>
      catalog.read({ agent: 'grok', workspacePath: '/workspace/project', savedOnly: true })
    expect(firstFrame(await nextComposer())).toEqual({ model: 'grok-4.6', effort: 'high' })
    const fields = { key: 'model', value: 'grok-4.7' }
    await host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    })
    await host.readOptions(SESSION)
    expect(firstFrame(await nextComposer())).toEqual({ model: 'grok-4.6', effort: 'high' })
  })

  it('reports the process model when the first message acquires the child', async () => {
    const { host, rig } = await openGrokHost('grok-4.6', {
      clientMessageId: 'opening',
      body: hostTestMessage('hello')
    })
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    expect((await host.readOptions(SESSION)).current).toMatchObject({ model: 'grok-4.6' })
  })
})
