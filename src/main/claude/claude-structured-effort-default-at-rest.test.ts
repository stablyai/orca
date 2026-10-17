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
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogScopeFingerprint
} from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from '../native-chat/agent-session-wire/structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-options-read'
import { claudeAndCodexAgents } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { composeCodexSessionOptionCatalog } from '../codex/codex-structured-model-catalog'
import { listedModels } from './claude-structured-model-catalog'
import { wireClaudeModels } from './claude-structured-catalog-listing'
import { nativeSessionOptionsFromReport } from '../native-chat/agent-session-wire/structured-agent-session-option-restoration'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  fakeClaude,
  identityFor,
  recordingJournalSink,
  claudeStartupSettled,
  claudeOpened
} from './claude-structured-session-test-support'

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

/** get_settings with nothing overriding the CLI's own default; an effort write moves both views.
 *  `model` is what the CLI says it runs, and `listing` the models it lists. */
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
  const models = wireClaudeModels(listedModels({ models: cli.lists ?? CATALOG }))
  if (models.length > 0) {
    store.recordSuccess(
      agentModelCatalogScopeFingerprint(
        agentModelCatalogFingerprintForRecord(restingRecord({})),
        '/work/repo'
      ),
      'claude',
      {
        models,
        configured: { model: cli.runs ?? 'claude-opus-5-5[1m]', effort: 'medium' },
        complete: true,
        origin: 'probe'
      },
      'discovery'
    )
  }
  return adapter
}

function restingRecord(options: Record<string, string>): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and the catalog key touch only these fields.
  return {
    sessionId: SESSION,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: ACCOUNT_HOME },
    location: { executionHostId: 'local', wslDistro: null },
    // Why released: a chat at rest has no live claim, so its next start reads the current account.
    lease: { claimStatus: 'released' },
    options
  } as unknown as AgentSessionRecord
}

function catalogService(store: AgentModelCatalogStore, record: AgentSessionRecord) {
  return createAgentModelCatalogService({
    store,
    getRecord: () => record,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: ACCOUNT_HOME }),
    recordWorkspacePath: async () => '/work/repo',
    workspaceMayOverrideDefaultModel: async () => false
  })
}

/** The options a client reads for the chat once its child is gone. */
function readAtRest(store: AgentModelCatalogStore, record: AgentSessionRecord) {
  const modelCatalog = catalogService(store, record)
  const resting = {
    child: null,
    params: { provider: 'claude' },
    journal: { threadGoal: () => null, contextUsage: () => null, context: { floor: () => null } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read touches only these members.
  const context = {
    deps: {
      adapter: {},
      agents: claudeAndCodexAgents(),
      store: { getRecord: () => record },
      modelCatalog
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  return readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
}

function pickerEffort(result: Awaited<ReturnType<typeof readAtRest>>, agent = 'claude') {
  const seed = getAgentSessionOptionCatalog(agent)!
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState(agent, seed),
    seed,
    result
  )
  const effort = structuredAgentSessionOptionSnapshot(state).find((row) => row.id === 'effort')
  return effort?.kind.type === 'select' ? effort.kind.currentValue : undefined
}

describe('Claude effort default at rest', () => {
  it('shows that default in the picker of a chat at rest', async () => {
    const store = new AgentModelCatalogStore()
    await startChild(store)

    const result = await readAtRest(store, restingRecord({ model: 'opus[1m]' }))

    expect(result.current).toMatchObject({ model: 'opus[1m]', effort: 'medium' })
    expect(pickerEffort(result)).toBe('medium')
  })

  it("shows the user's pick at rest over the default", async () => {
    const store = new AgentModelCatalogStore()
    await startChild(store)

    const result = await readAtRest(store, restingRecord({ model: 'opus[1m]', effort: 'max' }))

    expect(result.current.effort).toBe('max')
    expect(pickerEffort(result)).toBe('max')
  })

  it('offers no effort for a model the catalog does not list, at rest as live', async () => {
    const store = new AgentModelCatalogStore()
    const unlisted = { model: 'claude-unlisted-9', effort: 'medium' }
    // The CLI runs a model its own catalog does not list, as a newer or pinned model can be.
    const child = await startChild(store, unlisted, [], { runs: unlisted.model })
    const live = await child.readOptions({ sessionId: SESSION, fence: 7 })

    const resting = await readAtRest(store, restingRecord(unlisted))

    const row = (result: typeof resting) =>
      result.models.find((entry) => entry.id === unlisted.model)
    expect(row(live)).toEqual(expect.objectContaining({ id: unlisted.model, efforts: [] }))
    expect(row(resting)).toEqual(row(live))
    expect(pickerEffort(live)).toBeUndefined()
    expect(pickerEffort(resting)).toBeUndefined()
  })

  it('lists an unlisted Codex model at rest exactly as its live child does', async () => {
    const store = new AgentModelCatalogStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and the catalog key touch only these fields.
    const record = {
      sessionId: SESSION,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/codex' },
      location: { executionHostId: 'local', wslDistro: null },
      options: { model: 'gpt-unlisted', effort: 'high' }
    } as unknown as AgentSessionRecord
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
      agentModelCatalogScopeFingerprint(
        agentModelCatalogFingerprintForRecord(record),
        '/work/repo'
      ),
      'codex',
      {
        ...listing,
        origin: 'live-session'
      },
      'discovery'
    )

    const resting = await readAtRest(store, record)
    const live = composeCodexSessionOptionCatalog(listing, {
      current: { model: 'gpt-unlisted', effort: 'high' }
    })

    expect(resting.models).toEqual(live.models)
    expect(live.models.find((entry) => entry.id === 'gpt-unlisted')).toMatchObject({ efforts: [] })
    expect(pickerEffort(resting, 'codex')).toBeUndefined()
  })

  it("keeps a Claude model's effort at rest with no catalog yet, as a live child with none does", async () => {
    const saved = { model: 'opus', effort: 'high' }
    // A CLI that lists nothing: the live child falls back to Claude's built-in models.
    const child = await startChild(new AgentModelCatalogStore(), saved, [], {
      runs: 'opus',
      lists: []
    })
    const live = await child.readOptions({ sessionId: SESSION, fence: 7 })

    // An account the host has no catalog for yet.
    const resting = await readAtRest(new AgentModelCatalogStore(), restingRecord(saved))

    expect(resting.models).toEqual(live.models)
    expect(pickerEffort(live)).toBe('high')
    expect(pickerEffort(resting)).toBe('high')
  })

  it('names no model at rest with no pick and no catalog, so the client keeps what the child ran', async () => {
    // The CLI's default model, reported live; the chat never picked one.
    const child = await startChild(new AgentModelCatalogStore(), undefined, [], {
      runs: 'opus',
      lists: []
    })
    const live = await child.readOptions({ sessionId: SESSION, fence: 7 })

    const resting = await readAtRest(new AgentModelCatalogStore(), restingRecord({}))

    // The built-in list's default is a guess, not this account's: nothing to name.
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and the catalog key touch only these fields.
    const record = {
      sessionId: SESSION,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/codex' },
      location: { executionHostId: 'local', wslDistro: null },
      options: { model: 'gpt-5.5', effort: 'high' }
    } as unknown as AgentSessionRecord

    const resting = await readAtRest(new AgentModelCatalogStore(), record)

    // A Codex child lists nothing without its catalog, so the answer leaves the list to the client.
    expect(resting.models).toEqual([])
    expect(pickerEffort(resting, 'codex')).toBe('high')
  })

  it("leaves a Codex chat's unsaved effort blank at rest, as its live child does", async () => {
    const store = new AgentModelCatalogStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and the catalog key touch only these fields.
    const record = {
      sessionId: SESSION,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/codex' },
      location: { executionHostId: 'local', wslDistro: null },
      options: { model: 'gpt-5.5' }
    } as unknown as AgentSessionRecord
    store.recordSuccess(
      agentModelCatalogScopeFingerprint(
        agentModelCatalogFingerprintForRecord(record),
        '/work/repo'
      ),
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
        origin: 'live-session'
      },
      'discovery'
    )

    const result = await readAtRest(store, record)

    expect(result.current).toEqual({ model: 'gpt-5.5', permissionMode: 'ask' })
  })

  it("never saves the applied effort as the chat's pick, yet shows it at rest", async () => {
    const store = new AgentModelCatalogStore()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await startChild(store, undefined, events)

    const reported = (await claudeOpened(adapter, SESSION)).reportedOptions
    expect(reported).not.toHaveProperty('effort')
    // Applied effort is display metadata, never a saved selection.
    const record = restingRecord(
      nativeSessionOptionsFromReport({ reported: reported, restoreSkipped: [] })
    )
    expect(record.options).toEqual({ model: 'opus[1m]' })
    expect((await readAtRest(store, record)).current.effort).toBe('medium')
    expect(record.options).toEqual({ model: 'opus[1m]' })
  })
})
