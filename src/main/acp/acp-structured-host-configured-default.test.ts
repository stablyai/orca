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
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
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
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
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

/** A Grok chat opened with no model pick, whose own session runs `runs`. */
async function openGrokHost(runs: string) {
  const records: { store: AgentSessionRecordStore | null } = { store: null }
  const discovery = GROK.modelDiscovery
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getRecord: (sessionId) => records.store?.getRecord(sessionId) ?? undefined,
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
  expect(await rig.host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
  return { ...rig, catalog }
}

describe('Grok’s default comes from what a chat with no pick runs', () => {
  it('names no model before any chat ran, though the listing computed one', async () => {
    const { catalog } = await openGrokHost('grok-4.6')
    const answer = await catalog.read({ agent: 'grok', waitForListing: true })
    expect(answer).toMatchObject({ origin: 'probe', listingNamesConfiguredModel: false })
    expect(firstFrame(answer)).toEqual({ model: null, effort: null })
  })

  it('names 4.6, the model a chat with no pick ran, never the listing’s 4.7', async () => {
    const { catalog, host } = await openGrokHost('grok-4.6')
    await catalog.read({ agent: 'grok', waitForListing: true })
    expect((await host.readOptions(SESSION)).current).toMatchObject({ model: 'grok-4.6' })

    // The next new chat, in any workspace: Grok reads no project config for its model.
    const answer = await catalog.read({ agent: 'grok', workspacePath: '/elsewhere' })
    expect(answer).toMatchObject({
      listingNamesConfiguredModel: true,
      defaultHoldsInEveryWorkspace: true
    })
    expect(firstFrame(answer)).toEqual({ model: 'grok-4.6', effort: 'high' })
  })
})
