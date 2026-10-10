// Grok's session-free listing can name a model (`initialize`'s currentModelId) other than the one a
// session runs. The user's case: the listing said Grok 4.7, every chat ran Grok 4.6. Through the
// real Grok probe, adapter and host, a new chat's first frame names only what a chat ran.

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

/** Another Grok chat in the same workspace, as the host's record of it. */
function otherChat(store: AgentSessionRecordStore | null) {
  const first = store?.getRecord(SESSION)
  return first ? { ...first, sessionId: OTHER_CHAT } : undefined
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
  const discovery = GROK.modelDiscovery
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getRecord: (sessionId) =>
      records.store?.getRecord(sessionId) ??
      (sessionId === OTHER_CHAT ? otherChat(records.store) : undefined),
    drivesRecord: () => true,
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

    // The next new chat, in any workspace: Grok reads no project config for its model.
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
    // Delivery started the agent and handed it the opening message; nothing picked a model.
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    // Learned from the start the delivery made, before any options read.
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
    // Grok's default moved since: a newer chat with no pick starts on 4.7 and says so at its start.
    const newer = new AcpStructuredOptions()
    newer.adoptSession(
      { configOptions: SessionConfigOptionSchema.array().parse(GROK_CONFIG_OPTIONS) },
      'new'
    )
    catalog.recordLiveListing(OTHER_CHAT, newer.startListing())
    // The first chat keeps running and reads its options again, as every turn does.
    await host.readOptions(SESSION)
    const answer = await catalog.read({ agent: 'grok', workspacePath: '/elsewhere' })
    expect(firstFrame(answer)).toEqual({ model: 'grok-4.7', effort: 'high' })
  })
})
