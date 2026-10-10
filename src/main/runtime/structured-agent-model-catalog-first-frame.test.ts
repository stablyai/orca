import { describe, expect, it } from 'vitest'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { structuredAgentSessionSeedCatalog } from '../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { AcpStructuredOptions } from '../acp/acp-structured-options'
import { GROK_ACP_DIALECT } from '../acp/acp-dialects/grok-dialect'
import { grokModelCatalogFromState } from '../acp/acp-dialects/grok-model-catalog'
import { agentModelCatalogFingerprintForRecord } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { workspaceMayOverrideDefaultModel } from '../native-chat/agent-model-catalog/agent-project-model-override'
import {
  AgentModelCatalogStore,
  withLiveCatalogListing,
  type AgentModelCatalogProbe
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import type { StructuredAgentModelCatalogContext } from './structured-agent-runtime-registrations'
import { registeredModelCatalogDiscovery } from './structured-agent-model-catalog-wiring'

// The first frame a new chat paints, from the real registration list through the host service to
// the shared picker: nothing here passes the "names its default" answer by hand.

function context(): StructuredAgentModelCatalogContext {
  const unused = async (): Promise<never> => {
    throw new Error('building a probe resolves nothing')
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building a probe only captures resolvers; none of these deps is read until a probe runs.
    deps: { stateDirectory: '/state' } as StructuredAgentModelCatalogContext['deps'],
    environment: {
      resolveBaseEnvironment: unused,
      resolveCodexEnvironment: unused,
      resolveClaudeInheritedEnv: unused
    }
  }
}

const HOMES: Record<string, AgentSessionAccountHome> = {
  grok: { variable: 'GROK_HOME', path: '/homes/grok' },
  pi: { variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi' },
  claude: { variable: 'CLAUDE_CONFIG_DIR', path: '/homes/claude' }
}

const GROK_EFFORT_META = {
  supportsReasoningEffort: true,
  reasoningEfforts: [
    { value: 'low', id: 'low' },
    { value: 'high', id: 'high', default: true }
  ]
}

// What Grok's `initialize` reports with no session; its `currentModelId` names no default.
const GROK_LISTING = grokModelCatalogFromState({
  currentModelId: 'grok-4',
  availableModels: [
    { modelId: 'grok-4', name: 'Grok 4', _meta: GROK_EFFORT_META },
    { modelId: 'grok-3-mini', name: 'Grok 3 Mini' }
  ]
})

function grokRecord(): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog service reads only provider, accountHome and location.
  return {
    sessionId: 'grok-session',
    provider: 'grok',
    accountHome: HOMES.grok,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'ws-1',
      workspaceKind: 'git-worktree'
    }
  } as AgentSessionRecord
}

function service(
  store: AgentModelCatalogStore,
  listings: Record<string, AgentSessionModelOption[]>,
  records: AgentSessionRecord[] = []
) {
  const registered = registeredModelCatalogDiscovery(
    STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
    context()
  )
  const probes: Record<string, AgentModelCatalogProbe> = {}
  for (const [agent, models] of Object.entries(listings)) {
    probes[agent] = async () => ({ models, origin: 'probe' })
  }
  return createAgentModelCatalogService({
    store,
    getRecord: (sessionId) => records.find((record) => record.sessionId === sessionId),
    drivesRecord: () => true,
    resolveAccountHome: async (agent) => HOMES[agent]!,
    probes,
    workspaceMayOverrideDefaultModel,
    listingNamesConfiguredModel: registered.listingNamesConfiguredModel
  })
}

async function newChatFirstFrame(
  catalog: ReturnType<typeof service>,
  agent: string,
  workspacePath?: string
) {
  const host = await catalog.read({
    agent,
    waitForListing: true,
    ...(workspacePath ? { workspacePath } : {})
  })
  const seed = structuredAgentSessionSeedCatalog(agent)
  const state = applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState(agent, seed),
    seed,
    host,
    { newLaunch: true }
  )
  const snapshot = structuredAgentSessionOptionSnapshot(state)
  const select = (id: string) => {
    const descriptor = snapshot.find((entry) => entry.id === id)
    return descriptor?.kind.type === 'select' ? descriptor.kind : null
  }
  return { host, state, model: select('model'), effort: select('effort') }
}

describe('a new chat’s first frame from the host catalog', () => {
  it('lists a warm Grok account’s models without naming the one `initialize` computed', async () => {
    const catalog = service(new AgentModelCatalogStore(), { grok: GROK_LISTING })
    const { host, state, model } = await newChatFirstFrame(catalog, 'grok', '/repo')
    // A session can run another model; a chat started with no pick names the default instead.
    expect(host).toMatchObject({ origin: 'probe', listingNamesConfiguredModel: false })
    expect(model?.choices.map((choice) => choice.value)).toEqual(['grok-4', 'grok-3-mini'])
    expect(model?.currentValue).toBeUndefined()
    expect(state.record.model).toBeUndefined()
  })

  it('lists a warm Pi account’s models without naming one its listing does not name', async () => {
    const catalog = service(new AgentModelCatalogStore(), {
      pi: [
        {
          id: 'anthropic/sonnet',
          label: 'Sonnet',
          isDefault: false,
          efforts: [{ value: 'high', label: 'high' }]
        }
      ]
    })
    const { host, model } = await newChatFirstFrame(catalog, 'pi')
    expect(host).toMatchObject({ listingNamesConfiguredModel: false })
    expect(model?.choices.map((choice) => choice.value)).toEqual(['anthropic/sonnet'])
    expect(model?.currentValue).toBeUndefined()
  })
})

describe('a running chat’s listing, saved for the next chat', () => {
  it('keeps a Grok account warm from a live session, without its picks becoming defaults', async () => {
    const store = new AgentModelCatalogStore()
    const record = grokRecord()
    const catalog = service(store, { grok: GROK_LISTING }, [record])
    await newChatFirstFrame(catalog, 'grok')
    // The running chat switched to the mini model and reports a list with one more model.
    const options = new AcpStructuredOptions(GROK_ACP_DIALECT)
    options.adoptSession({
      models: {
        currentModelId: 'grok-3-mini',
        availableModels: [
          { modelId: 'grok-4', name: 'Grok 4', _meta: GROK_EFFORT_META },
          { modelId: 'grok-3-mini', name: 'Grok 3 Mini' },
          { modelId: 'grok-code', name: 'Grok Code' }
        ]
      }
    })
    catalog.recordLiveListing(
      record.sessionId,
      withLiveCatalogListing(options.read()).catalogListing
    )

    const { host, model, effort } = await newChatFirstFrame(catalog, 'grok')
    expect(host.origin).toBe('live-session')
    expect(model?.choices.map((choice) => choice.value)).toEqual([
      'grok-4',
      'grok-3-mini',
      'grok-code'
    ])
    // A loaded session's model is its own, never the account's default.
    expect(model?.currentValue).toBeUndefined()
    expect(effort).toBeNull()
  })

  it('keeps per-model efforts a session only knows for the model it runs', async () => {
    const store = new AgentModelCatalogStore()
    const record: AgentSessionRecord = {
      ...grokRecord(),
      provider: 'opencode',
      sessionId: 'oc',
      accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
    }
    const listed: AgentSessionModelOption[] = [
      { id: 'a', label: 'A', isDefault: false, efforts: [{ value: 'max', label: 'Max' }] },
      { id: 'b', label: 'B', isDefault: false, efforts: [{ value: 'low', label: 'Low' }] }
    ]
    const catalog = service(store, {}, [record])
    store.recordSuccess(
      agentModelCatalogFingerprintForRecord(record),
      'opencode',
      {
        models: listed,
        origin: 'probe'
      },
      'discovery'
    )
    catalog.recordLiveListing(record.sessionId, {
      models: [
        { id: 'a', label: 'A', isDefault: false, efforts: [{ value: 'high', label: 'High' }] },
        { id: 'b', label: 'B', isDefault: false, efforts: [] }
      ]
    })
    const read = await catalog.read({ agent: 'opencode', sessionId: 'oc' })
    expect(read.origin === 'unknown' ? null : read.models.map((m) => m.efforts)).toEqual([
      [{ value: 'high', label: 'High' }],
      [{ value: 'low', label: 'Low' }]
    ])
  })

  it('saves a Claude live listing through the same step as every other agent', async () => {
    const store = new AgentModelCatalogStore()
    const record = { ...grokRecord(), provider: 'claude', accountHome: HOMES.claude! }
    const catalog = service(store, {}, [record])
    catalog.recordLiveListing(record.sessionId, {
      models: [{ id: 'opus', label: 'Opus', isDefault: false, efforts: [] }]
    })
    const read = await catalog.read({ agent: 'claude', sessionId: record.sessionId })
    expect(read.origin === 'unknown' ? null : read.models.map((m) => m.id)).toEqual(['opus'])
  })
})
