import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { getAgentSessionOptionCatalog } from '../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  agentModelCatalogScopeFingerprint,
  agentModelCatalogFingerprintForRecord
} from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from '../native-chat/agent-session-wire/structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-options-read'
import { structuredAgentSessionSendSelection } from '../../shared/structured-agent-session-option-view'
import { claudeAndCodexAgents } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { composeCodexSessionOptionCatalog } from '../codex/codex-structured-model-catalog'
import { listedModels } from './claude-structured-model-catalog'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'
import {
  PROVIDER_SESSION_ID,
  fakeClaude,
  identityFor,
  recordingJournalSink
} from './claude-structured-session-test-support'
import {
  claudeStartupSettled,
  claudeOpened
} from './claude-structured-startup-settled-test-support'

const SESSION = 'session-1'
const ACCOUNT_HOME = '/accounts/claude'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Claude Code 2.1.280's list_models rows: `default` resolves to the opus row. */
const CATALOG = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5[1m]',
    displayName: 'Default (recommended)',
    supportsEffort: true,
    supportedEffortLevels: EFFORTS
  },
  {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-5-5[1m]',
    displayName: 'Opus (1M context)',
    supportsEffort: true,
    supportedEffortLevels: EFFORTS
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: EFFORTS
  }
]

/** A settings write updates both effective and applied effort, as the CLI does. */
function settingsWithNoOverride(model = 'claude-opus-5-5[1m]', listing: unknown[] = CATALOG) {
  const effective: { effortLevel?: string } = {}
  const settings = {
    effective,
    sources: [],
    applied: { model, effort: 'medium', advisor: null, ultracode: false }
  }
  const claude = fakeClaude({
    initProof: 'session-start',
    initModel: model,
    initModels: listing,
    settings,
    routes: {
      list_models: () => listing,
      apply_flag_settings: (params) => {
        const written = params?.settings
        const effort =
          typeof written === 'object' && written !== null && 'effortLevel' in written
            ? written.effortLevel
            : undefined
        if (typeof effort === 'string') {
          effective.effortLevel = effort
          settings.applied.effort = effort
        }
      }
    }
  })
  return claude
}

async function startChild(
  store: AgentModelCatalogStore,
  options?: Record<string, string>,
  events: ClaudeStructuredSessionEvent[] = [],
  cli: { runs?: string; lists?: unknown[] } = {}
): Promise<ClaudeStructuredSessionAdapter> {
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: ACCOUNT_HOME,
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    onEvent: (event) => events.push(event),
    openConnection: settingsWithNoOverride(cli.runs, cli.lists).openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async () => {}
  })
  await adapter.acquire({
    identity: identityFor(SESSION),
    fence: 7,
    spawnToken: 'spawn-9',
    events: recordingJournalSink(),
    ...(options ? { options } : {})
  })
  await claudeStartupSettled(adapter, SESSION)
  // Seed discovery independently of saved chat choices.
  if (cli.lists?.length !== 0) {
    const record = restingRecord({})
    store.recordSuccess(
      exactKey(record),
      'claude',
      {
        models: listedModels({ models: CATALOG }),
        origin: 'probe',
        complete: true,
        configured: { model: 'opus[1m]', effort: 'medium' }
      },
      'discovery'
    )
  }
  return adapter
}

function restingRecord(
  options: Record<string, string>,
  providerHandleChain: { origin: 'created' | 'adopted' }[] = []
): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId: SESSION,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: ACCOUNT_HOME },
    providerHandleChain: providerHandleChain.map(({ origin }, index) => ({
      origin,
      linkId: `link-${index}`,
      mintedAtFence: 1,
      observedAt: 0,
      handle: claudeProviderHandle('thread-1', null)
    })),
    location: { executionHostId: 'local', wslDistro: null },
    options
  })
}

function exactKey(record: AgentSessionRecord): string {
  return agentModelCatalogScopeFingerprint(
    agentModelCatalogFingerprintForRecord(record),
    '/work/repo'
  )
}

function catalogDefault(store: AgentModelCatalogStore, model: string): string | undefined {
  const entry = store.get(exactKey(restingRecord({})))
  return entry?.models.find((row) => row.id === model)?.defaultEffort
}

function catalogService(store: AgentModelCatalogStore, record: AgentSessionRecord) {
  return createAgentModelCatalogService({
    store,
    getConversation: () => {
      const saved = record
      return saved ? agentSessionConversationView(saved) : undefined
    },
    getRecord: () => record,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: ACCOUNT_HOME }),
    // No workspace overrides: use the account configuration.
    recordWorkspacePath: async () => '/work/repo',
    workspaceMayOverrideDefaultModel: async () => false
  })
}

/** The options a client reads for the chat once its child is gone. */
async function readAtRest(store: AgentModelCatalogStore, record: AgentSessionRecord) {
  const modelCatalog = catalogService(store, record)
  // Acquiring this scope is separate from the passive picker read below.
  await modelCatalog.prepareSaved({
    agent: record.provider,
    sessionId: SESSION,
    inSessionWorkspace: true
  })
  const resting = {
    child: null,
    params: { provider: 'claude' },
    journal: {
      threadGoal: () => null,
      visitItems: () => {},
      submissions: () => [],
      contextUsage: () => null,
      context: { floor: () => null }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read touches only these members.
  const context = {
    deps: {
      adapter: {},
      agents: claudeAndCodexAgents(),
      store: {
        getRecord: () => record,
        getConversation: () => (record ? agentSessionConversationView(record) : null),
        requireWritableRecord: () => record
      },
      modelCatalog
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  try {
    return await readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
  } finally {
    modelCatalog.stop()
  }
}

function pickerEffortRow(result: Awaited<ReturnType<typeof readAtRest>>, agent = 'claude') {
  const seed = getAgentSessionOptionCatalog(agent)!
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState(agent, seed),
    seed,
    result
  )
  return structuredAgentSessionOptionSnapshot(state).find((row) => row.id === 'effort')
}

function pickerEffort(result: Awaited<ReturnType<typeof readAtRest>>, agent = 'claude') {
  const effort = pickerEffortRow(result, agent)
  return effort?.kind.type === 'select' ? effort.kind.currentValue : undefined
}

const READ_ONLY_EFFORT = (value: string, label = value) => ({
  settable: false,
  kind: { type: 'select', currentValue: value, choices: [{ value, label }] }
})

describe('Claude effort default at rest', () => {
  it('uses the independently discovered configured effort at rest', async () => {
    const store = new AgentModelCatalogStore()
    await startChild(store)

    // Discovery measured Opus only; Sonnet has no observed default.
    expect(catalogDefault(store, 'opus[1m]')).toBe('medium')
    expect(catalogDefault(store, 'sonnet')).toBeUndefined()
  })

  it('shows that default in the picker of a chat at rest', async () => {
    const store = new AgentModelCatalogStore()
    await startChild(store)

    const result = await readAtRest(store, restingRecord({ model: 'opus[1m]' }))

    expect(result.current).toMatchObject({ model: 'opus[1m]', effort: 'medium' })
    expect(pickerEffort(result)).toBe('medium')
  })

  it('names the default for a reopened chat with no saved model, and its run reports that row', async () => {
    const store = new AgentModelCatalogStore()
    const child = await startChild(store)
    const seed = getAgentSessionOptionCatalog('claude')!
    const picker = (answer: Awaited<ReturnType<typeof readAtRest>>) => {
      const state = applyStructuredAgentSessionOptions(
        createStructuredAgentSessionOptionState('claude', seed),
        seed,
        answer
      )
      const row = structuredAgentSessionOptionSnapshot(state).find((entry) => entry.id === 'model')
      const shown = row?.kind.type === 'select' ? row.kind.currentValue : undefined
      return { shown, sends: structuredAgentSessionSendSelection(state)?.model }
    }
    const reopened = await readAtRest(store, restingRecord({}, [{ origin: 'adopted' }]))
    expect(reopened.current).toMatchObject({ model: 'opus[1m]', defaulted: ['model', 'effort'] })
    expect(picker(reopened)).toEqual({ shown: 'opus[1m]', sends: undefined })

    const ran = (await child.readOptions({ sessionId: SESSION, fence: 7 })).current
    expect(ran).toMatchObject({ model: 'claude-opus-5-5[1m]' })
    expect(ran.defaulted ?? []).not.toContain('model')
  })

  it("shows the user's pick at rest over the default", async () => {
    const store = new AgentModelCatalogStore()
    await startChild(store)

    const result = await readAtRest(store, restingRecord({ model: 'opus[1m]', effort: 'max' }))

    expect(result.current.effort).toBe('max')
    expect(pickerEffort(result)).toBe('max')
  })

  it("never learns a user's pick as the default", async () => {
    const store = new AgentModelCatalogStore()
    const restored = await startChild(store, { model: 'opus[1m]', effort: 'high' })
    await restored.readOptions({ sessionId: SESSION, fence: 7 })
    expect(catalogDefault(store, 'opus[1m]')).toBe('medium')

    const other = new AgentModelCatalogStore()
    const live = await startChild(other)
    await live.setOption({ sessionId: SESSION, fence: 7, key: 'effort', value: 'xhigh' })
    expect((await live.readOptions({ sessionId: SESSION, fence: 7 })).current.effort).toBe('xhigh')
    expect(catalogDefault(other, 'opus[1m]')).toBe('medium')
  })

  it('offers no effort menu for a model the catalog does not list, at rest as live', async () => {
    const store = new AgentModelCatalogStore()
    const unlisted = { model: 'claude-unlisted-9', effort: 'medium' }
    const child = await startChild(store, unlisted, [], { runs: unlisted.model })
    const live = await child.readOptions({ sessionId: SESSION, fence: 7 })

    const resting = await readAtRest(store, restingRecord(unlisted))

    const row = (result: typeof resting) =>
      result.models.find((entry) => entry.id === unlisted.model)
    expect(row(live)).toEqual(expect.objectContaining({ id: unlisted.model, efforts: [] }))
    expect(row(resting)).toEqual(row(live))
    // Supply the host catalog IDs when the live child omits them.
    expect(pickerEffortRow({ ...live, listedModelIds: resting.listedModelIds })).toMatchObject(
      READ_ONLY_EFFORT(unlisted.effort, 'Medium')
    )
    expect(pickerEffortRow(resting)).toMatchObject(READ_ONLY_EFFORT(unlisted.effort, 'Medium'))
  })

  it('lists an unlisted Codex model at rest exactly as its live child does', async () => {
    const store = new AgentModelCatalogStore()
    const record = agentSessionRecordFixture({
      sessionId: SESSION,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/codex' },
      providerHandleChain: [],
      location: { executionHostId: 'local', wslDistro: null },
      options: { model: 'gpt-unlisted', effort: 'high' }
    })
    const listing = {
      models: [
        {
          id: 'gpt-5.5',
          label: 'GPT-5.5',
          isDefault: true,
          efforts: [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    }
    store.recordSuccess(
      exactKey(record),
      'codex',
      {
        ...listing,
        origin: 'probe',
        complete: true
      },
      'discovery'
    )

    const resting = await readAtRest(store, record)
    const live = composeCodexSessionOptionCatalog(listing, {
      current: { model: 'gpt-unlisted', effort: 'high' }
    })

    expect(resting.models).toEqual(live.models)
    expect(live.models.find((entry) => entry.id === 'gpt-unlisted')).toMatchObject({ efforts: [] })
    for (const answer of [resting, { ...live, listedModelIds: resting.listedModelIds }]) {
      expect(pickerEffortRow(answer, 'codex')).toMatchObject(READ_ONLY_EFFORT('high', 'High'))
    }
  })

  it("keeps a Claude model's effort at rest with no catalog yet, as a live child with none does", async () => {
    const saved = { model: 'opus', effort: 'high' }
    const child = await startChild(new AgentModelCatalogStore(), saved, [], {
      runs: 'opus',
      lists: []
    })
    const live = await child.readOptions({ sessionId: SESSION, fence: 7 })

    const resting = await readAtRest(new AgentModelCatalogStore(), restingRecord(saved))

    expect(resting.models).toEqual(live.models)
    expect(pickerEffort(live)).toBe('high')
    expect(pickerEffort(resting)).toBe('high')
  })

  it('names no model at rest with no pick and no catalog, so the client keeps what the child ran', async () => {
    const child = await startChild(new AgentModelCatalogStore(), undefined, [], {
      runs: 'opus',
      lists: []
    })
    const live = await child.readOptions({ sessionId: SESSION, fence: 7 })

    const resting = await readAtRest(new AgentModelCatalogStore(), restingRecord({}))

    // Built-in defaults do not establish this account's configured model.
    expect(resting.current).not.toHaveProperty('model')
    const seed = getAgentSessionOptionCatalog('claude')!
    const state = [live, resting].reduce(
      (current, answer) => applyStructuredAgentSessionOptions(current, seed, answer),
      createStructuredAgentSessionOptionState('claude', seed)
    )
    const model = structuredAgentSessionOptionSnapshot(state).find((row) => row.id === 'model')
    expect(model?.kind.type === 'select' ? model.kind.currentValue : undefined).toBe('opus')
  })

  it("keeps a Codex model's effort at rest with no catalog yet, from the client's own defaults", async () => {
    const record = agentSessionRecordFixture({
      sessionId: SESSION,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/codex' },
      providerHandleChain: [],
      location: { executionHostId: 'local', wslDistro: null },
      options: { model: 'gpt-5.5', effort: 'high' }
    })

    const resting = await readAtRest(new AgentModelCatalogStore(), record)

    expect(resting.models).toEqual([
      { id: 'gpt-5.5', label: 'gpt-5.5', isDefault: false, efforts: [], effortsKnown: false }
    ])
    expect(pickerEffort(resting, 'codex')).toBe('high')
  })

  it("leaves a Codex chat's unsaved effort blank at rest, as its live child does", async () => {
    const store = new AgentModelCatalogStore()
    const record = agentSessionRecordFixture({
      sessionId: SESSION,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/codex' },
      providerHandleChain: [],
      location: { executionHostId: 'local', wslDistro: null },
      options: { model: 'gpt-5.5' }
    })
    store.recordSuccess(
      exactKey(record),
      'codex',
      {
        models: [
          {
            id: 'gpt-5.5',
            label: 'GPT-5.5',
            isDefault: true,
            defaultEffort: 'medium',
            efforts: [
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]
          }
        ],
        origin: 'probe',
        complete: true
      },
      'discovery'
    )

    const result = await readAtRest(store, record)

    expect(result.current).toEqual({ model: 'gpt-5.5', defaulted: [], permissionMode: 'ask' })
  })

  it("never saves the applied effort as the chat's pick, yet shows it at rest", async () => {
    const store = new AgentModelCatalogStore()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await startChild(store, undefined, events)

    const reported = (await claudeOpened(adapter, SESSION)).reportedOptions
    expect(reported).not.toHaveProperty('effort')
    const record = restingRecord({ model: 'opus[1m]' })
    expect(record.options).toEqual({ model: 'opus[1m]' })
    expect((await readAtRest(store, record)).current.effort).toBe('medium')
    expect(record.options).toEqual({ model: 'opus[1m]' })
  })
})
