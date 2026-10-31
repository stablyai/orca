import {
  hostTestCatalogReadOperation,
  hostTestRestingOptionsRecord as restingRecord,
  hostTestRestingOptionsJournal as restingJournal,
  hostTestOptionsReadStore
} from './structured-agent-session-host-test-data'
import {
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import { structuredAgentSessionSendSelection } from '../../../shared/structured-agent-session-option-view'

import { describe, expect, it, vi } from 'vitest'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from '../agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'
import { AcpStructuredOptions } from '../../acp/acp-structured-options'
import { GROK_CONFIG_OPTIONS } from '../../acp/acp-structured-adapter.test-support'
import { SessionConfigOptionSchema } from '../../acp/generated/acp-protocol.generated'
import { withLiveCatalogListing } from '../agent-model-catalog/agent-model-catalog-entry'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../shared/agent-session-option-catalog-claude-codex'
import { createRestTestRig } from './structured-agent-session-rest-test-rig'
import { agentSessionRecordFixture as durableAgentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { seedTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const SESSION = 'session-1'

describe('options at rest', () => {
  it('keeps an unknown Claude observation out of cold sends while retaining warm aliases', async () => {
    const rig = await createRestTestRig()
    try {
      const fixture = durableAgentSessionRecordFixture()
      await seedTestAgentSessionRecordStore(rig.root, { records: [fixture] })
      await rig.restart()
      const seed = CLAUDE_SESSION_OPTION_CATALOG
      const result = await rig.host.readOptions(fixture.sessionId)
      expect(result.current.model).toBeUndefined()
      expect(result.models.length).toBeGreaterThan(0)
      expect(result.models.every((model) => !model.isDefault)).toBe(true)
      expect(result.conversationCommands).toContain('clear')
      const cold = createStructuredAgentSessionOptionState('claude', seed)
      const observe = (state: typeof cold) =>
        applyStructuredAgentSessionOptions(state, seed, result)
      expect(structuredAgentSessionSendSelection(observe(cold))).toBeUndefined()
      const warm = commitStructuredAgentSessionOptionValues(
        createStructuredAgentSessionOptionState('claude', seed),
        { model: 'opus[1m]', effort: 'max' }
      )
      expect(structuredAgentSessionSendSelection(observe(warm))).toEqual({
        model: 'opus[1m]'
      })
      expect(warm.record.values.model.value).toBe('opus[1m]')
      expect(warm.record.values.effort).toBeUndefined()
      expect(rig.store.getRecord(fixture.sessionId)?.options).toBeUndefined()
      expect(rig.adapter.acquire).not.toHaveBeenCalled()
      expect(seed.models.some((model) => model.isDefault)).toBe(true)
    } finally {
      await rig.dispose()
    }
  })

  it('keeps the account model for an older client when the starting child has no folder default', async () => {
    const record = restingRecord()
    const read = vi.fn(async (params: { inSessionWorkspace?: true }) => ({
      origin: 'probe' as const,
      models: [
        {
          id: params.inSessionWorkspace ? 'gpt-folder' : 'gpt-account',
          label: 'Model',
          isDefault: !params.inSessionWorkspace,
          efforts: []
        }
      ],
      fetchedAt: 1
    }))
    const starting = {
      child: { phase: 'starting' },
      params: { provider: 'codex' },
      journal: restingJournal()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: {},
        agents: NO_STRUCTURED_AGENTS,
        store: hostTestOptionsReadStore(() => record),
        modelCatalog: { read, captureRead: hostTestCatalogReadOperation }
      },
      serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
      openConversation: async () => starting,
      conversation: async () => starting
    } as unknown as StructuredAgentSessionMutationContext

    const current = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: true
    })
    expect(current.current).toEqual({
      defaulted: [],
      permissionMode: 'ask',
      acceptedInputSources: {}
    })
    expect(read).toHaveBeenCalledTimes(2)
    const older = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: false
    })
    expect(older.current).toEqual({
      acceptedInputSources: { model: 'policy' },
      model: 'gpt-account',
      defaulted: [],
      permissionMode: 'ask'
    })
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        sessionId: SESSION,
        savedOnly: true,
        legacyOptionsDisplay: true,
        workspacePath: null
      })
    )
  })

  it('keeps a saved Codex model when the host listing drops it', async () => {
    const record = { ...restingRecord(), options: { model: 'gpt-unlisted', effort: 'high' } }
    const listed = { id: 'gpt-5.5', label: 'GPT-5.5', isDefault: true, efforts: [] }
    let live = false
    const conversation = () => ({
      child: live ? { fence: 7 } : null,
      params: { provider: 'codex' },
      journal: restingJournal()
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: {
          readOptions: async () => ({
            models: [listed, { ...listed, id: 'gpt-unlisted', isDefault: false }],
            current: { model: 'gpt-5.5', effort: 'high', defaulted: ['model'] }
          })
        },
        agents: NO_STRUCTURED_AGENTS,
        store: hostTestOptionsReadStore(() => record),
        modelCatalog: {
          captureRead: hostTestCatalogReadOperation,
          read: async () => ({ origin: 'probe', models: [listed], fetchedAt: 1 })
        }
      },
      serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
      openConversation: async () => conversation(),
      conversation: async () => conversation()
    } as unknown as StructuredAgentSessionMutationContext
    const read = () =>
      readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
    const resting = await read()
    live = true
    const running = await read()
    expect(running.listedModelIds).toEqual(resting.listedModelIds)
    expect(resting.listedModelIds).toEqual(['gpt-5.5'])
    expect(resting.current).toMatchObject({ model: 'gpt-unlisted', defaulted: [] })
    expect(running.current).toMatchObject({ model: 'gpt-unlisted', defaulted: [] })
    for (const answer of [resting, running]) {
      expect(answer.current.acceptedInputSources).toMatchObject({ model: 'saved', effort: 'saved' })
    }
  })

  it.each(['omp', 'grok', 'opencode'] as const)(
    '%s keeps an unknown model and learns menus from qualified reports',
    async (provider) => {
      const record = { ...restingRecord(), provider }
      const probe = vi.fn(() => new Promise<AgentModelCatalogSuccess>(() => {}))
      const modelCatalog = createAgentModelCatalogService({
        store: new AgentModelCatalogStore(),
        ...hostTestOptionsReadStore(() => record),
        drivesRecord: () => true,
        resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/homes/a' }),
        probes: { codex: probe }
      })
      let live = false
      const reader = new AcpStructuredOptions()
      const configOptions = SessionConfigOptionSchema.array().parse(GROK_CONFIG_OPTIONS)
      const resting = {
        child: null,
        params: { provider: 'codex' },
        journal: restingJournal()
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: options reads touch only these context members.
      const context = {
        deps: {
          adapter: { readOptions: async () => withLiveCatalogListing(reader.read()) },
          agents: NO_STRUCTURED_AGENTS,
          store: hostTestOptionsReadStore(() => record),
          modelCatalog
        },
        serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
        openConversation: async () => (live ? { ...resting, child: { fence: 7 } } : resting),
        conversation: async () => resting
      } as unknown as StructuredAgentSessionMutationContext

      const read = () =>
        readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
      const result = await read()
      expect(probe).not.toHaveBeenCalled()
      expect(result.models).toEqual([])
      expect(result.current).not.toHaveProperty('model')
      record.options = { model: 'later-model', effort: 'off' }
      // Unregistered agents must not report a permission mode.
      expect((await read()).current).toEqual({
        model: 'later-model',
        effort: 'off',
        acceptedInputSources: { model: 'saved', effort: 'saved' },
        defaulted: []
      })
      for (const emptyStart of [false, true]) {
        modelCatalog.recordLiveListing(SESSION, {
          models: [{ id: 'old', label: 'Old', isDefault: true, efforts: [] }]
        })
        reader.adoptSession(emptyStart ? {} : { configOptions })
        modelCatalog.recordLiveListing(SESSION, reader.startListing())
        reader.adoptConfigOptions(
          configOptions.map((option) =>
            option.type === 'select' && option.category === 'model'
              ? { ...option, currentValue: 'grok-4.6' }
              : option
          )
        )
        record.options = { model: 'grok-4.6', effort: 'high' }
        live = true
        await read()
        modelCatalog.recordLiveListing(SESSION, { models: reader.read().models })
        live = false
        const answer = await read()
        expect(answer.models).toEqual(reader.read().models)
      }
    }
  )
})
