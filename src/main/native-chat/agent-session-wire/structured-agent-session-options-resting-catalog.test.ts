import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../shared/agent-session-option-catalog-claude-codex'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import {
  applyNativeChatSessionOptionPicks,
  resolveStructuredLaunchSeedOptions
} from '../../../shared/native-chat-session-option-defaults'
import { agentModelCatalogFingerprintForRecord } from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { agentModelLaunchOptions } from '../agent-model-catalog/agent-model-catalog-selection'
import {
  AGENT_MODEL_CATALOG_CURRENT_MS,
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AGENT_MODEL_CATALOG_START_WAIT_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from '../agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  readStructuredAgentSessionOptions,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

const LOW = { value: 'low', label: 'Low' }
const HIGH = { value: 'high', label: 'High' }
const XHIGH = { value: 'xhigh', label: 'Extra high' }
// Claude's account-level listing names no default model; its first row is what a gone pick becomes.
const SONNET: AgentSessionModelOption = {
  id: 'sonnet',
  label: 'Sonnet',
  isDefault: false,
  efforts: [LOW, HIGH]
}
const OPUS: AgentSessionModelOption = {
  id: 'opus',
  label: 'Opus',
  isDefault: false,
  efforts: [LOW, HIGH, XHIGH]
}

function listing(models: AgentSessionModelOption[]): AgentModelCatalogSuccess {
  return { models, fastModeTierByModel: new Map(), origin: 'probe' }
}

function restingChat(input: {
  provider?: 'claude' | 'codex'
  options?: Record<string, string>
  /** How old the saved list is when the chat is read. */
  ageMs?: number
  /** What the host's session-less listing answers now; absent, it fails; `hangs`, never answers. */
  relists?: AgentSessionModelOption[] | 'hangs'
}) {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ claimStatus: 'released', ownerProcess: null })
  )
  record.provider = input.provider ?? 'claude'
  record.location.workspaceKind = 'folder'
  record.accountHome = {
    variable: record.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
    path: '/accounts/pinned'
  }
  record.options = input.options ?? {}
  // A selection the user picked; a caller's model is never replaced.
  if (record.options.model) {
    record.modelChosenBy = 'picker'
  }
  const clock = { now: 1_000 }
  const store = new AgentModelCatalogStore({ now: () => clock.now })
  store.recordSuccess(
    agentModelCatalogFingerprintForRecord(record),
    record.provider,
    listing([SONNET]),
    'discovery'
  )
  clock.now += input.ageMs ?? 0
  const relists = input.relists
  const probe = vi.fn(async (_home: unknown, _options?: unknown) => {
    if (relists === 'hangs') {
      return new Promise<AgentModelCatalogSuccess>(() => {})
    }
    if (!relists) {
      throw new Error('temporarily unavailable')
    }
    return listing(relists)
  })
  const agents = claudeAndCodexDeclared()
  const modelCatalog = createAgentModelCatalogService({
    store,
    getRecord: () => record,
    drivesRecord: () => true,
    agents,
    probes: { [record.provider]: probe },
    resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/selected' })
  })
  const resting = {
    child: null,
    params: { provider: record.provider },
    journal: { contextUsage: () => null, threadGoal: () => null, context: { floor: () => null } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this at-rest read uses only these context members; no child or journal mutation runs.
  const context = {
    deps: { adapter: {}, agents, store: { getRecord: () => record }, modelCatalog },
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  const read = async () => {
    const result = await readStructuredAgentSessionOptions(context, record.sessionId)
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
      CLAUDE_SESSION_OPTION_CATALOG,
      result
    )
    return { result, state }
  }
  const write = (key: string, value: string) =>
    recordStructuredAgentSessionOptionIntent(
      { store: { getRecord: () => record }, agents },
      {
        sessionId: record.sessionId,
        persistOptions: async (options, modelChosenBy) => {
          record.options = options
          if (modelChosenBy) {
            record.modelChosenBy = modelChosenBy
          }
        },
        publish: () => {}
      },
      { key, value }
    )
  // The picker's follow-up read, which waits for the re-listing an at-rest read only starts.
  const listed = () =>
    modelCatalog.read({ agent: record.provider, sessionId: record.sessionId, waitForListing: true })
  // What the next start launches with.
  const launch = () => agentModelLaunchOptions(modelCatalog, agents, record)
  return { record, clock, probe, modelCatalog, read, write, listed, launch }
}

function snapshotRow(state: StructuredAgentSessionOptionState, id: string) {
  return structuredAgentSessionOptionSnapshot(state).find((row) => row.id === id)
}

describe('Claude picker catalog at rest', () => {
  it.each([0, AGENT_MODEL_CATALOG_CURRENT_MS])(
    'never adopts a saved default after an effort-only edit (list age %s ms)',
    async (ageMs) => {
      const { record, read, write } = restingChat({ ageMs })
      const { result, state } = await read()
      expect(await write('effort', 'low')).toMatchObject({
        ok: true,
        value: { options: { effort: 'low' } }
      })
      const persisted = applyNativeChatSessionOptionPicks({
        persisted: null,
        agent: 'claude',
        picks: structuredAgentSessionOptionPicks(state, record.options ?? {})
      })
      expect(resolveStructuredLaunchSeedOptions(persisted, 'claude')?.model).toBeUndefined()
      expect(result.current).toEqual({})
      const model = snapshotRow(state, 'model')
      expect(model).toMatchObject({ valueSource: 'unknown' })
      expect(model?.kind).not.toHaveProperty('currentValue')
      expect(canSetStructuredAgentSessionOption(state, 'effort', 'low')).toBe(false)
    }
  )

  it("re-lists an aged list once and keeps the chat's model with its real efforts", async () => {
    const chat = restingChat({
      options: { model: 'opus', effort: 'xhigh' },
      ageMs: AGENT_MODEL_CATALOG_CURRENT_MS,
      relists: [SONNET, OPUS]
    })
    // The read itself never waits: the saved model stands while the list is re-listed.
    expect((await chat.read()).result.current).toEqual({ model: 'opus', effort: 'xhigh' })
    await chat.listed()
    const { result, state } = await chat.read()
    expect(chat.probe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: '/accounts/pinned' }),
      expect.anything()
    )
    expect(result.current).toEqual({ model: 'opus', effort: 'xhigh' })
    expect(result.models).toContainEqual(
      expect.objectContaining({ id: 'opus', efforts: OPUS.efforts })
    )
    expect(snapshotRow(state, 'effort')?.kind).toEqual({
      type: 'select',
      currentValue: 'xhigh',
      choices: OPUS.efforts
    })
    expect(await chat.launch()).toEqual({
      model: 'opus',
      effort: 'xhigh'
    })
    expect(chat.probe).toHaveBeenCalledOnce()
  })

  it.each([
    ['high', { model: 'sonnet', effort: 'high' }],
    ['xhigh', { model: 'sonnet', effort: 'high' }],
    ['unranked', { model: 'sonnet' }]
  ])(
    'moves a model the fresh list confirms gone to the default, carrying effort %s to its nearest level',
    async (effort, settled) => {
      const chat = restingChat({
        options: { model: 'opus', effort },
        ageMs: AGENT_MODEL_CATALOG_CURRENT_MS,
        relists: [SONNET]
      })
      expect((await chat.read()).result.current).toEqual({ model: 'opus', effort })
      await chat.listed()
      const { result, state } = await chat.read()
      expect(result.current).toEqual(settled)
      expect(snapshotRow(state, 'model')?.kind).toMatchObject({ currentValue: 'sonnet' })
      expect(snapshotRow(state, 'effort')?.kind).toMatchObject({ choices: SONNET.efforts })
      // The next start names the default explicitly; the read itself writes nothing.
      expect(await chat.launch()).toEqual(settled)
      expect(chat.record.options).toEqual({ model: 'opus', effort })
      expect(chat.probe).toHaveBeenCalledOnce()
    }
  )

  it('replaces at once from a list listed within the last minute', async () => {
    const chat = restingChat({
      options: { model: 'opus', effort: 'high' },
      ageMs: AGENT_MODEL_CATALOG_CURRENT_MS - 1
    })
    const { result } = await chat.read()
    expect(result.current).toEqual({ model: 'sonnet', effort: 'high' })
    expect(chat.probe).not.toHaveBeenCalled()
  })

  it('keeps an unverified selection, invents no efforts, and re-lists once per failure window', async () => {
    const chat = restingChat({
      options: { model: 'opus', effort: 'xhigh' },
      ageMs: AGENT_MODEL_CATALOG_CURRENT_MS
    })
    const { result, state } = await chat.read()
    expect(result.current).toEqual({ model: 'opus', effort: 'xhigh' })
    expect(result.models.find((row) => row.id === 'opus')).toMatchObject({ efforts: [] })
    expect(snapshotRow(state, 'model')?.kind).toMatchObject({ currentValue: 'opus' })
    expect(snapshotRow(state, 'effort')).toBeUndefined()
    expect(canSetStructuredAgentSessionOption(state, 'effort', 'xhigh')).toBe(false)
    expect(await chat.launch()).toEqual({
      model: 'opus',
      effort: 'xhigh'
    })
    await chat.read()
    expect(chat.probe).toHaveBeenCalledOnce()
    chat.clock.now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    await chat.read()
    expect(chat.probe).toHaveBeenCalledTimes(2)
  })

  it('never waits on a hanging re-listing at rest, and a start waits for it only briefly', async () => {
    vi.useFakeTimers()
    try {
      const chat = restingChat({
        options: { model: 'opus', effort: 'xhigh' },
        ageMs: AGENT_MODEL_CATALOG_CURRENT_MS,
        relists: 'hangs'
      })
      expect((await chat.read()).result.current).toEqual({ model: 'opus', effort: 'xhigh' })
      let launched: Readonly<Record<string, string>> | undefined
      void chat.launch().then((options) => {
        launched = options
      })
      await vi.advanceTimersByTimeAsync(AGENT_MODEL_CATALOG_START_WAIT_MS - 1)
      expect(launched).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(launched).toEqual({ model: 'opus', effort: 'xhigh' })
      expect(chat.probe).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the Codex resting policy: no re-listing, no replacement', async () => {
    const chat = restingChat({
      provider: 'codex',
      options: { model: 'gpt-unlisted' },
      ageMs: AGENT_MODEL_CATALOG_CURRENT_MS,
      relists: [SONNET]
    })
    const { result } = await chat.read()
    expect(result.current).toEqual({ model: 'gpt-unlisted' })
    expect(chat.probe).not.toHaveBeenCalled()
  })
})

describe('who chose a stopped chat model', () => {
  it("marks a model picked at rest as the picker's, and an effort-only pick keeps who chose it", async () => {
    const chat = restingChat({ options: { model: 'claude-sonnet-4-5', effort: 'high' } })
    // A model a caller named, which no later list replaces until the user picks one.
    chat.record.modelChosenBy = 'caller'
    await chat.write('effort', 'low')
    expect(chat.record.modelChosenBy).toBe('caller')
    await chat.write('model', 'claude-opus-4-5')
    expect(chat.record.options).toMatchObject({ model: 'claude-opus-4-5' })
    expect(chat.record.modelChosenBy).toBe('picker')
  })
})
