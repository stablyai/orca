// A Claude chat at rest shows the effort its next start will run: a live child teaches the host
// catalog what the CLI runs for each model when no effort is sent, and the resting read answers it.

import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { getAgentSessionOptionCatalog } from '../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentModelCatalogFingerprintForRecord } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from '../native-chat/agent-session-wire/structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-options-read'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  fakeClaude,
  identityFor,
  recordingJournalSink
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

/** get_settings with nothing overriding the CLI's own default; an effort write moves both views. */
function settingsWithNoOverride() {
  const effective: { effortLevel?: string } = {}
  const settings = {
    effective,
    sources: [],
    applied: { model: 'claude-opus-5-5[1m]', effort: 'medium', advisor: null, ultracode: false }
  }
  const claude = fakeClaude({
    initProof: 'session-start',
    initModels: CATALOG,
    settings,
    routes: {
      list_models: () => CATALOG,
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
  events: ClaudeStructuredSessionEvent[] = []
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
    openConnection: settingsWithNoOverride().openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async () => {},
    modelCatalog: store
  })
  await adapter.acquire({
    identity: identityFor(SESSION),
    fence: 7,
    spawnToken: 'spawn-9',
    events: recordingJournalSink(),
    ...(options ? { options } : {})
  })
  await adapter.awaitStarted(SESSION)
  return adapter
}

function restingRecord(options: Record<string, string>): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and the catalog key touch only these fields.
  return {
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: ACCOUNT_HOME },
    location: { wslDistro: null },
    options
  } as unknown as AgentSessionRecord
}

function catalogDefault(store: AgentModelCatalogStore, model: string): string | undefined {
  const entry = store.get(agentModelCatalogFingerprintForRecord(restingRecord({})))
  return entry?.models.find((row) => row.id === model)?.defaultEffort
}

/** The options a client reads for the chat once its child is gone. */
function readAtRest(store: AgentModelCatalogStore, record: AgentSessionRecord) {
  const modelCatalog = createAgentModelCatalogService({
    store,
    getRecord: () => record,
    resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: ACCOUNT_HOME })
  })
  const resting = { child: null, params: { provider: 'claude' } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read touches only these members.
  const context = {
    deps: { adapter: {}, store: { getRecord: () => record }, modelCatalog },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  return readStructuredAgentSessionOptions(context, SESSION)
}

function pickerEffort(result: Awaited<ReturnType<typeof readAtRest>>) {
  const seed = getAgentSessionOptionCatalog('claude')!
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('claude', seed),
    seed,
    result
  )
  const effort = structuredAgentSessionOptionSnapshot(state).find((row) => row.id === 'effort')
  return effort?.kind.type === 'select' ? effort.kind.currentValue : undefined
}

describe('Claude effort default at rest', () => {
  it("learns the model's default from a live child's applied effort", async () => {
    const store = new AgentModelCatalogStore()
    await startChild(store)

    // Both rows run claude-opus-5-5[1m]; sonnet was not applied, so nothing is known of it.
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
    expect(catalogDefault(store, 'opus[1m]')).toBeUndefined()

    const other = new AgentModelCatalogStore()
    const live = await startChild(other)
    await live.setOption({ sessionId: SESSION, fence: 7, key: 'effort', value: 'xhigh' })
    expect((await live.readOptions({ sessionId: SESSION, fence: 7 })).current.effort).toBe('xhigh')
    expect(catalogDefault(other, 'opus[1m]')).toBe('medium')
  })

  it("never saves the applied effort as the chat's own pick", async () => {
    const store = new AgentModelCatalogStore()
    const events: ClaudeStructuredSessionEvent[] = []
    await startChild(store, undefined, events)

    const started = events.find((event) => event.type === 'started')
    expect(started?.type === 'started' ? started.reportedOptions : null).not.toHaveProperty(
      'effort'
    )
    const record = restingRecord({ model: 'opus[1m]' })
    await readAtRest(store, record)
    expect(record.options).toEqual({ model: 'opus[1m]' })
  })
})
