import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
// Regression: initialize listed Grok 4.7 while new sessions actually ran Grok 4.6.

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
import { AcpStructuredOptions } from './acp-structured-options'
import { SessionConfigOptionSchema } from './generated/acp-protocol.generated'
import { AcpSessionRuntime } from './acp-session-runtime'
import { GROK, GROK_CONFIG_OPTIONS } from './acp-structured-adapter.test-support'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
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

const OTHER_CHAT = 'grok-chat-2'

function otherChat(store: AgentSessionRecordStore | null) {
  const first = store?.getRecord(SESSION)
  return first
    ? { ...first, sessionId: OTHER_CHAT, lease: { ...first.lease, sessionId: OTHER_CHAT } }
    : undefined
}

const agents: AcpScriptedAgent[] = []
afterEach(async () => {
  for (const agent of agents.splice(0)) {
    agent.close()
  }
  await closeProviderTimelineRigs()
})

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

function firstFrame(answer: AgentSessionModelCatalogResult) {
  const seed = structuredAgentSessionSeedCatalog('grok')
  const state = applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('grok', seed),
    seed,
    answer,
    { newLaunch: true }
  )
  const snapshot = structuredAgentSessionOptionSnapshot(state)
  const select = (id: string) => {
    const entry = snapshot.find((descriptor) => descriptor.id === id)
    return entry?.kind.type === 'select' ? (entry.kind.currentValue ?? null) : null
  }
  return { model: select('model'), effort: select('effort') }
}

/** With `create`, only first-message delivery starts the agent. */
async function openGrokHost(runs: string, create?: StructuredAgentSessionFirstMessage) {
  const records: { store: AgentSessionRecordStore | null } = { store: null }
  const discovery = GROK.modelDiscovery
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: (id) => {
      const saved =
        records.store?.getRecord(id) ?? (id === OTHER_CHAT ? otherChat(records.store) : undefined)
      return saved ? agentSessionConversationView(saved) : undefined
    },
    getRecord: (sessionId) =>
      records.store?.getRecord(sessionId) ??
      (sessionId === OTHER_CHAT ? otherChat(records.store) : undefined),
    drivesRecord: () => true,
    resolveAccountHome: async () => GROK_HOME,
    recordWorkspacePath: async () => '/workspace/project',
    agentReadsProjectModelConfig,
    workspaceMayOverrideDefaultModel,
    probes: { grok: grokProbe() },
    listingNamesConfiguredModel: new Set(
      discovery.kind !== 'unavailable' && discovery.listingNamesConfiguredModel ? ['grok'] : []
    )
  })
  const opened = GROK_CONFIG_OPTIONS.map((option) =>
    option.id === 'model' ? { ...option, currentValue: runs } : option
  )
  const rig = await openHostRig({
    modelCatalog: catalog,
    script: (agent) =>
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: 'acp-session-1', configOptions: opened })
      ),
    deps: { resolveLaunch: launch(() => false) }
  })
  records.store = rig.store
  const listed = await catalog.read({ agent: 'grok', waitForListing: true })
  const opening = create
    ? rig.host.create(CALLER, createTestParams(create, attachParams()), { firstMessage: create })
    : rig.host.attach(CALLER, attachParams())
  expect(await opening).toMatchObject({ ok: true })
  if (!create) {
    await rig.ready()
  }
  return { ...rig, catalog, listed }
}

describe('Grok’s default comes from what a chat with no pick runs', () => {
  it('names no model before any chat ran, though the listing computed one', async () => {
    const { listed } = await openGrokHost('grok-4.6')
    expect(listed).toMatchObject({ origin: 'probe', listingNamesConfiguredModel: false })
    expect(firstFrame(listed)).toEqual({ model: null, effort: null })
  })

  it('names 4.6, the model a chat with no pick ran, never the listing’s 4.7', async () => {
    const { catalog, host } = await openGrokHost('grok-4.6')
    expect((await host.readOptions(SESSION)).current).toMatchObject({ model: 'grok-4.6' })

    const answer = await catalog.read({ agent: 'grok', workspacePath: '/elsewhere' })
    expect(answer).toMatchObject({
      listingNamesConfiguredModel: true,
      defaultHoldsInEveryWorkspace: true
    })
    expect(firstFrame(answer)).toEqual({ model: 'grok-4.6', effort: 'high' })
  })

  it('learns 4.6 from a chat created with its first message and no pick', async () => {
    const { catalog, host, rig } = await openGrokHost('grok-4.6', {
      clientMessageId: 'opening',
      body: hostTestMessage('hello')
    })
    await catalog.read({ agent: 'grok', waitForListing: true })
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    // The start taught the catalog before any options read.
    expect(firstFrame(await catalog.read({ agent: 'grok', workspacePath: '/elsewhere' }))).toEqual({
      model: 'grok-4.6',
      effort: 'high'
    })

    expect((await host.readOptions(SESSION)).current).toMatchObject({ model: 'grok-4.6' })
    const answer = await catalog.read({ agent: 'grok', workspacePath: '/elsewhere' })
    expect(answer).toMatchObject({ listingNamesConfiguredModel: true })
    expect(firstFrame(answer)).toEqual({ model: 'grok-4.6', effort: 'high' })
  })

  it('a chat’s later reads teach nothing: a newer chat’s default stands', async () => {
    const { catalog, host } = await openGrokHost('grok-4.6')
    // A newer unpicked session reports the account's changed default.
    const newer = new AcpStructuredOptions()
    newer.adoptSession(
      { configOptions: SessionConfigOptionSchema.array().parse(GROK_CONFIG_OPTIONS) },
      'new'
    )
    catalog.recordLiveListing(OTHER_CHAT, newer.startListing())
    await host.readOptions(SESSION)
    const answer = await catalog.read({ agent: 'grok', workspacePath: '/elsewhere' })
    expect(firstFrame(answer)).toEqual({ model: 'grok-4.7', effort: 'high' })
  })
})
