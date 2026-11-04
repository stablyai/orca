import { claudeOpened } from '../../claude/claude-structured-startup-settled-test-support'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import type { ClaudeStructuredSessionEvent } from '../../claude/structured/claude-structured-session-state'
import { startCodexTurn } from '../../codex/codex-structured-turn-start'
import { readLiveCodexSessionOptions } from '../../codex/codex-structured-session-options'
import { optionSession } from '../../codex/codex-structured-option-session.test-fixture'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { structuredAgentSessionDrawnValues } from '../../../shared/structured-agent-session-option-snapshot'
import { structuredAgentSessionCapabilityView } from './structured-agent-session-option-models'
import { claudeFallbackModelOptions } from '../../claude/claude-structured-session-options'
import {
  acquired,
  fakeClaude,
  claudeFrame,
  USER_MESSAGE
} from '../../claude/claude-structured-session-test-support'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import { structuredAgentSessionSendSelection } from '../../../shared/structured-agent-session-option-view'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  hostTestRestingOptionsRecord as restingRecord,
  HOST_TEST_RESTING_OPTIONS_CREATED_LINKS as created,
  hostTestRestingOptionsJournal as restingJournal,
  hostTestOptionsReadStore
} from './structured-agent-session-host-test-data'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from '../agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  readStructuredAgentSessionOptions,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'
import { AcpStructuredOptions } from '../../acp/acp-structured-options'
import { GROK_CONFIG_OPTIONS } from '../../acp/acp-structured-adapter.test-support'
import { SessionConfigOptionSchema } from '../../acp/generated/acp-protocol.generated'
import { withLiveCatalogListing } from '../agent-model-catalog/agent-model-catalog-entry'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import { agentModelCatalogFingerprintForRecord } from '../agent-model-catalog/agent-model-catalog-fingerprint'
import {
  saveStructuredAgentSessionStartReadbackListing,
  type StructuredAgentSessionStartListingContext
} from './structured-agent-session-start-listing'
import { recordAgentSessionRanOptions } from '../../runtime/agent-session-record-options'
import {
  claudeAndCodexAgents,
  NO_STRUCTURED_AGENTS
} from './structured-agent-session-adapter-router-test-support'

const SESSION = 'session-1'

type RestingFacts = Pick<
  Partial<AgentSessionRecord>,
  'options' | 'provider' | 'providerHandleChain' | 'rewind'
>

describe('options at rest', () => {
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
        modelCatalog: { read }
      },
      serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
      openConversation: async () => starting,
      conversation: async () => starting
    } as unknown as StructuredAgentSessionMutationContext

    const current = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: true
    })
    expect(current.current).toEqual({ defaulted: [], permissionMode: 'ask' })
    expect(read).toHaveBeenCalledTimes(2)
    const older = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: false
    })
    expect(older.current).toEqual({
      model: 'gpt-account',
      defaulted: [],
      permissionMode: 'ask'
    })
    expect(read).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: SESSION,
      savedOnly: true,
      legacyOptionsDisplay: true,
      workspacePath: null
    })
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
        modelCatalog: { read: async () => ({ origin: 'probe', models: [listed], fetchedAt: 1 }) }
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

describe('a chat at rest, read by the host', () => {
  const turn: AgentJournalItemBody = { kind: 'turn', turnId: 'turn-1', state: 'completed' }
  const fast = [{ value: 'priority', label: 'Fast' }]
  const flex = [...fast, { value: 'flex', label: 'Flex' }]
  const listed: AgentSessionModelOption[] = [
    { id: 'gpt-account', label: 'Model', isDefault: true, efforts: [], serviceTiers: fast },
    { id: 'gpt-flex', label: 'Flex', isDefault: false, efforts: [], serviceTiers: flex }
  ]
  const catalog = (models: AgentSessionModelOption[] | null = listed, verified = true) => ({
    read: async (params?: { verifiedOnly?: boolean }) =>
      models === null || (!verified && params?.verifiedOnly)
        ? { origin: 'unknown' as const }
        : { origin: 'probe' as const, models, fetchedAt: 1 }
  })
  function readAtRest(
    facts: RestingFacts,
    items: AgentJournalItemBody[] = [],
    wroteBeforeOpen = false,
    models: AgentSessionModelOption[] | null = listed,
    verified = true,
    liveOptions?: StructuredAgentSessionLiveOptions
  ) {
    const record = { ...restingRecord(), ...facts }
    const resting = {
      child: liveOptions ? { fence: 1 } : null,
      params: { provider: record.provider },
      journal: restingJournal(items, wroteBeforeOpen)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: liveOptions ? { readOptions: async () => liveOptions } : {},
        agents: claudeAndCodexAgents(),
        store: hostTestOptionsReadStore(() => record),
        modelCatalog: catalog(models, verified)
      },
      serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
      openConversation: async () => resting,
      conversation: async () => resting
    } as unknown as StructuredAgentSessionMutationContext
    return readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
  }

  it.each<[string, RestingFacts, AgentJournalItemBody[], boolean, string[]]>([
    ['started here names its default as its own', {}, [], false, []],
    [
      'taken from history',
      { providerHandleChain: [{ ...created[0]!, origin: 'adopted' }] },
      [],
      true,
      ['model']
    ],
    // A context clear hides the turn from the newest-turn read, not from history.
    ['with a turn before a context clear', {}, [turn], true, ['model']],
    [
      'after a rewind',
      {
        rewind: {
          phase: 'completed',
          operationId: 'rewind-1',
          callerKey: 'caller-1',
          itemId: 'item-1',
          expectedEpoch: 'epoch-1'
        }
      },
      [],
      true,
      ['model']
    ],
    // A journal founded afresh proves nothing for a chat whose agent already ran.
    ['whose journal went missing', { providerHandleChain: created }, [], false, ['model']]
  ])('%s', async (_name, facts, items, wroteBeforeOpen, defaulted) => {
    const read = await readAtRest(facts, items, wroteBeforeOpen)
    expect(read.current).toMatchObject({ model: 'gpt-account', defaulted })
  })

  it('preserves sparse Codex knowledge from an actual turn through host and shared desktop/phone values', async () => {
    const pending = Promise.withResolvers<unknown>()
    const request = vi.fn(() => pending.promise)
    const native = optionSession(request)
    native.appliedTurnOptions = { model: 'B', effort: 'high', serviceTier: 'rapid' }
    const inventory = [
      { id: 'A', label: 'A', isDefault: true, efforts: [], serviceTiers: [] },
      {
        id: 'B',
        label: 'B',
        isDefault: false,
        efforts: [],
        serviceTiers: [{ value: 'rapid', label: 'Fast' }]
      },
      { id: 'C', label: 'C', isDefault: false, efforts: [], serviceTiers: [] }
    ]
    const store = new AgentModelCatalogStore()
    native.catalogAccess = { store, fingerprint: 'fixture', accountHomePath: '/fixture' }
    store.recordSuccess(
      'fixture',
      'codex',
      { origin: 'probe', complete: true, models: inventory },
      'discovery'
    )
    const previous = await readLiveCodexSessionOptions(native, undefined)
    const sendTurn = (id: string) =>
      startCodexTurn(native, {
        clientMessageId: id,
        requestedAt: 1,
        body: USER_MESSAGE,
        turnOptions: { model: 'C' }
      })
    const sending = sendTurn('uncertain').catch((error: unknown) => error)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(native.appliedTurnOptions).toEqual({ effort: 'high', serviceTier: 'rapid' })
    const assertProjection = async (models: AgentSessionModelOption[] | null) => {
      const provider = await readLiveCodexSessionOptions(native, undefined)
      expect(provider.current).toMatchObject({ effort: 'high', serviceTier: 'rapid' })
      expect(provider.current).not.toHaveProperty('model')
      expect(provider.current).not.toHaveProperty('fastMode')
      const savedOptions: Record<string, string>[] = [{}, { model: 'C' }]
      for (const saved of savedOptions) {
        const host = await readAtRest({ options: saved }, [turnBody], true, models, true, provider)
        expect(host.current.serviceTier).toBe('rapid')
        const seed = getAgentSessionOptionCatalog('codex')!
        let state = applyStructuredAgentSessionModelCatalog(
          createStructuredAgentSessionOptionState('codex'),
          seed,
          models ? { origin: 'probe', models, fetchedAt: 1 } : { origin: 'unknown' },
          { newLaunch: false }
        )
        state = applyStructuredAgentSessionOptions(state, seed, {
          ...previous,
          current: { ...previous.current, defaulted: [] }
        })
        state = applyStructuredAgentSessionOptions(state, seed, host)
        expect(structuredAgentSessionDrawnValues(state).serviceTier?.value).toBe('rapid')
        expect(state.record.values.model?.value).toBe(host.current.model)
      }
    }
    const turnBody = turn
    await assertProjection(inventory)
    native.catalogAccess = undefined
    await assertProjection(null)
    pending.reject(new Error('transport uncertainty'))
    expect(await sending).toBeInstanceOf(Error)
    await assertProjection(null)
    native.appliedTurnOptions = { model: 'B', effort: 'high', serviceTier: 'rapid' }
    request.mockRejectedValueOnce(new CodexAppServerRequestError('turn/start', -32602, 'refused'))
    await expect(sendTurn('refused')).rejects.toThrow('refused')
    expect(native.appliedTurnOptions?.model).toBe('B')
    request.mockResolvedValueOnce({ turn: { id: 'accepted' } })
    await sendTurn('accepted')
    expect(native.appliedTurnOptions).toEqual({ model: 'C', effort: 'high', serviceTier: 'rapid' })
  })

  it('uses seeds only for an unknown inventory, never beside known rows or a known empty list', () => {
    const seed = claudeFallbackModelOptions()
    expect(
      structuredAgentSessionCapabilityView({ origin: 'unknown' }, undefined, seed).models
    ).toEqual(seed)
    expect(structuredAgentSessionCapabilityView({ models: [] }, undefined, seed).models).toEqual([])
    expect(
      structuredAgentSessionCapabilityView({ models: listed }, undefined, seed).models
    ).toEqual(listed)
  })

  it('uses installed choices for a live picker, admission and genuine first-run values', async () => {
    const installed = [
      {
        id: 'opus',
        label: 'Opus',
        isDefault: false,
        efforts: [{ value: 'high', label: 'High' }],
        supportsFastMode: true
      }
    ]
    const answer: StructuredAgentSessionLiveOptions = {
      models: claudeFallbackModelOptions(),
      current: { model: 'opus', effort: 'low' }
    }
    const result = await readAtRest(
      { provider: 'claude', options: { model: 'opus', effort: 'low' } },
      [],
      false,
      installed,
      true,
      answer
    )
    expect(result.models).toEqual(installed)
    expect(result.current).toMatchObject({ model: 'opus', effort: 'low' })
    const chat = picking({ model: 'opus' }, installed, undefined, 'claude')
    expect(await chat.pick('effort', 'low')).toMatchObject({ ok: true })
    expect(await chat.pick('effort', 'high')).toMatchObject({ ok: true })
    const firstRun = picking({ model: 'opus' }, installed, undefined, 'claude')
    firstRun.ran('opus', { effort: 'low' })
    expect(firstRun.record().options).toEqual({ model: 'opus', effort: 'low' })
  })

  it.each<[string, AgentSessionModelOption[] | null, string | undefined]>([
    [
      'known default',
      [{ id: 'opus[1m]', label: 'Opus', isDefault: true, efforts: [] }],
      'opus[1m]'
    ],
    ['unknown list', null, 'sonnet'],
    ['known empty', [], undefined],
    [
      'known without default',
      [{ id: 'opus', label: 'Opus', isDefault: false, efforts: [] }],
      undefined
    ]
  ])('composes %s for a live Claude child that names no model', async (_name, installed, model) => {
    const adapter = await acquired(fakeClaude({ settings: { effective: {}, sources: [] } }))
    const live = await adapter.readOptions({ sessionId: SESSION, fence: 7 })
    expect(live.current.model).toBeUndefined()
    const answer = await readAtRest({ provider: 'claude' }, [], false, installed, true, live)
    expect(answer.current.model).toBe(model)
    expect(answer.current.defaulted).toEqual([])
    if (installed === null) {
      const atRest = await readAtRest({ provider: 'claude' }, [], false, installed)
      expect(atRest.current.model).toBeUndefined()
    }
    const seed = getAgentSessionOptionCatalog('claude')!
    const launch = { newLaunch: true, coherentCatalog: true }
    const state = applyStructuredAgentSessionOptions(
      applyStructuredAgentSessionModelCatalog(
        createStructuredAgentSessionOptionState('claude', seed),
        seed,
        installed === null
          ? { origin: 'unknown' }
          : { origin: 'probe', models: installed, fetchedAt: 1 },
        launch
      ),
      seed,
      answer,
      launch
    )
    expect(structuredAgentSessionSendSelection(state)).toEqual(model ? { model } : undefined)
    const resumed = await readAtRest(
      {
        provider: 'claude',
        providerHandleChain: [
          {
            ...created[0]!,
            origin: 'adopted',
            handle: claudeProviderHandle('provider-session-1', null)
          }
        ]
      },
      [],
      true,
      installed,
      true,
      live
    )
    expect(resumed.current.defaulted).toEqual(model ? ['model'] : [])
    expect(
      structuredAgentSessionSendSelection(
        applyStructuredAgentSessionOptions(
          createStructuredAgentSessionOptionState('claude', seed),
          seed,
          resumed
        )
      )
    ).toBeUndefined()
  })

  it('resolves only an unsaved reported identity against installed rows', async () => {
    const installed = [
      {
        id: 'opus[1m]',
        resolvedModel: 'claude-opus-current',
        label: 'Installed Opus',
        isDefault: false,
        efforts: [{ value: 'high', label: 'High' }]
      }
    ]
    for (const [reported, saved, shown] of [
      ['claude-opus-current', {}, 'opus[1m]'],
      ['unknown-model', {}, 'unknown-model'],
      ['claude-opus-current', { model: 'claude-opus-current' }, 'claude-opus-current']
    ] as const) {
      const result = await readAtRest(
        { provider: 'claude', options: saved },
        [],
        false,
        installed,
        true,
        { models: [], current: { model: reported } }
      )
      expect(result.current.model).toBe(shown)
      expect(result.models.find((row) => row.id === shown)).toMatchObject(
        shown === 'opus[1m]'
          ? { label: 'Installed Opus', efforts: installed[0]!.efforts }
          : { label: shown, efforts: [] }
      )
    }
  })

  it('uses held rows as menus without projecting an unverified default effort', async () => {
    const answer = await readAtRest(
      { provider: 'claude', options: { model: 'gpt-account' } },
      [],
      false,
      [{ ...listed[0]!, defaultEffort: 'high', efforts: [{ value: 'high', label: 'High' }] }],
      false
    )
    expect(answer.current.model).toBe('gpt-account')
    expect(answer.current.effort).toBeUndefined()
    expect(answer.models[0]?.defaultEffort).toBe('high')
    const complete = await readAtRest(
      { provider: 'claude', options: { model: 'gpt-account' } },
      [],
      false,
      answer.models
    )
    expect(complete.current.effort).toBe('high')
  })

  it.each([
    ['another model offers', listed, 'default'],
    // Unlisted Codex Flex remains configured without inferred catalog support.
    ['no model lists', listed.slice(0, 1), 'flex']
  ])(
    'names the tier the model runs where %s it, and keeps the saved one',
    async (_n, models, runs) => {
      const options = { model: 'gpt-account', serviceTier: 'flex' }
      const answer = await readAtRest({ options }, [], false, models)
      expect(answer.current).toMatchObject({ serviceTier: runs })
      const chat = picking(options, models)
      expect(await chat.pick('model', 'gpt-account')).toMatchObject({
        value: { options: { serviceTier: 'flex' } }
      })
      expect(chat.record().options?.serviceTier).toBe('flex')
    }
  )

  const high = [{ value: 'high', label: 'High' }]
  const efforts: AgentSessionModelOption[] = [
    { id: 'a', label: 'A', isDefault: true, efforts: high },
    { id: 'b', label: 'B', isDefault: false, efforts: high },
    { id: 'c', label: 'C', isDefault: false, efforts: [] }
  ]
  function picking(
    options: Record<string, string>,
    models = efforts,
    projectOptions?: (
      sessionId: string,
      options: Readonly<Record<string, string>>
    ) => {
      models: AgentSessionModelOption[]
      options: Record<string, string>
    },
    provider = 'codex'
  ) {
    let record: AgentSessionRecord = { ...restingRecord(), options, provider }
    const store = {
      ...hostTestOptionsReadStore(() => record),
      replaceSessionOptions: vi.fn(),
      reviseSessionOptions: async <A>(
        revise: (held: AgentSessionRecord, args: A) => AgentSessionRecord,
        args: A
      ) => (record = revise(record, args))
    }
    const deps = {
      store,
      agents: claudeAndCodexAgents(),
      modelCatalog: catalog(models),
      adapter: { projectOptions }
    }
    const ctx = { sessionId: SESSION, fence: 1, publish: vi.fn(), now: () => 0 }
    return {
      pick: (key: string, value: string) =>
        recordStructuredAgentSessionOptionIntent(deps, ctx, { key, value }),
      ran: (model: string, ran: Record<string, string>, rows = models) =>
        (record = recordAgentSessionRanOptions(record, {
          sessionId: SESSION,
          fence: 1,
          now: 0,
          model,
          options: ran,
          models: rows
        })),
      record: () => record,
      inventory: deps.modelCatalog
    }
  }

  it('keeps literal picks and rejects late evidence from another model', async () => {
    const chat = picking({ model: 'a', effort: 'high' })
    await chat.pick('model', 'c')
    expect(chat.record().options).toEqual({ model: 'c', effort: 'high' })
    expect(await chat.pick('effort', 'high')).toMatchObject({ ok: true })
    await chat.pick('model', 'b')
    // A turn that ran on another model, recorded late, fills nothing, though b offers its effort.
    expect(chat.ran('a', { effort: 'high' }).options).toEqual({ model: 'b', effort: 'high' })
    expect(chat.ran('b', { effort: 'high' }).options).toEqual({ model: 'b', effort: 'high' })
    chat.ran('b', { effort: 'low' }, [])
    await chat.pick('serviceTier', 'priority')
    expect(chat.record().options).toEqual({ model: 'b', effort: 'high', serviceTier: 'priority' })
  })

  it('saves literal and permission picks while inventory is unresolved', async () => {
    const chat = picking({ model: 'a' })
    const read = vi.spyOn(chat.inventory, 'read').mockImplementation(() => new Promise(() => {}))
    expect(await chat.pick('model', 'not-listed')).toMatchObject({ ok: true })
    expect(await chat.pick('effort', 'high')).toMatchObject({ ok: true })
    expect(await chat.pick('permissionMode', 'ask')).toMatchObject({ ok: true })
    expect(read).not.toHaveBeenCalled()
    expect(chat.record().options).toEqual({ model: 'not-listed', effort: 'high' })
  })

  it('keeps saved literal values after the installed list omits their model', async () => {
    const inventory = [{ id: 'B', label: 'B', isDefault: false, efforts: [] }]
    const chat = picking({ model: 'opus[1m]', effort: 'low' }, inventory, undefined, 'claude')
    const answer = await readAtRest(
      { provider: 'claude', options: { model: 'opus[1m]', effort: 'low' } },
      [],
      false,
      inventory,
      true,
      { models: [], current: { model: 'claude-opus-5-5[1m]' } }
    )
    expect(answer.models.map((row) => row.id)).toEqual(['B', 'opus[1m]'])
    expect(answer.models[1]).toMatchObject({ efforts: [], effortsKnown: false })
    expect(answer.current).toMatchObject({ model: 'opus[1m]', effort: 'low' })
    chat.ran('opus[1m]', { effort: 'high' })
    expect(chat.record().options).toEqual({ model: 'opus[1m]', effort: 'low' })
  })

  it('fences a live read and newly received startup report to their actual child through folder awaits', async () => {
    const record = agentSessionRecordFixture({ sessionId: SESSION, provider: 'opencode2' })
    const folder = Promise.withResolvers<string | null>()
    const lookup = vi.fn(() => folder.promise)
    const store = new AgentModelCatalogStore()
    const catalog = createAgentModelCatalogService({
      store,
      ...hostTestOptionsReadStore(() => record),
      drivesRecord: () => true,
      resolveAccountHome: async () => record.accountHome,
      recordWorkspacePath: lookup,
      listsInChatFolder: new Set(['opencode2'])
    })
    const queue = new StructuredAgentSessionTaskQueue()
    const child = (generation: string, fence: number) => ({
      generation,
      fence,
      phase: 'ready' as const,
      catalogSource: catalog.captureSource(record)
    })
    const live = {
      child: child('old', 7),
      params: { provider: record.provider },
      journal: restingJournal()
    }
    const sessions = new Map([[SESSION, live]])
    let model = 'old'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real read and startup publisher use only these context members.
    const context = {
      deps: {
        adapter: {
          readOptions: async () =>
            withLiveCatalogListing({
              models: [{ id: model, label: model, isDefault: false, efforts: [] }],
              current: { model }
            })
        },
        agents: NO_STRUCTURED_AGENTS,
        store: hostTestOptionsReadStore(() => record),
        modelCatalog: catalog,
        logger: { warn: vi.fn() }
      },
      sessions,
      serialize: (sessionId: string, task: () => Promise<unknown>) =>
        queue.serialize(sessionId, task),
      openConversation: async () => live,
      conversation: async () => live
    } as unknown as StructuredAgentSessionMutationContext &
      StructuredAgentSessionStartListingContext
    const read = () =>
      readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
    try {
      await read()
      expect(lookup).not.toHaveBeenCalled()
      const report = (generation: string, fence: number) =>
        saveStructuredAgentSessionStartReadbackListing(
          context,
          { sessionId: SESSION, acquisitionGeneration: generation, fence },
          { models: [{ id: model, label: model, isDefault: false, efforts: [] }] }
        )
      await report('old', 7)
      await vi.waitFor(() => expect(lookup).toHaveBeenCalled())
      await queue.serialize(SESSION, async () => {
        store.expireAgent(record.provider)
        live.child = child('new', 8)
        model = 'current'
      })
      await read()
      await report('new', 8)
      // The old child's first receipt after replacement cannot acquire the new child's authority.
      await saveStructuredAgentSessionStartReadbackListing(
        context,
        {
          sessionId: SESSION,
          acquisitionGeneration: 'old',
          fence: 7
        },
        { models: [{ id: 'late', label: 'Late', isDefault: true, efforts: [] }] }
      )
      folder.resolve('/project')
      const key = agentModelCatalogFingerprintForRecord(record, '/project')
      await vi.waitFor(() =>
        expect(store.get(key)?.models.map((row) => row.id)).toEqual(['current'])
      )
      const current = store.get(key)
      await saveStructuredAgentSessionStartReadbackListing(
        context,
        {
          sessionId: SESSION,
          acquisitionGeneration: 'old',
          fence: 7
        },
        { models: [{ id: 'late-again', label: 'Late', isDefault: true, efforts: [] }] }
      )
      expect(store.get(key)).toBe(current)
    } finally {
      folder.resolve('/project')
      catalog.stop()
    }
  })
})

it('projects held Claude reports through the full reader while actual controls and Send proceed', async () => {
  const events: ClaudeStructuredSessionEvent[] = []
  const native = fakeClaude()
  const adapter = await acquired(native, {}, events)
  await claudeOpened(adapter, SESSION)
  const connection = native.connections[0]!
  const pending = Promise.withResolvers<unknown>()
  const settings = vi.spyOn(connection, 'getSettings').mockReturnValueOnce(pending.promise)
  const queue = new StructuredAgentSessionTaskQueue()
  const record = { ...restingRecord(), provider: 'claude', options: {} }
  const live = { child: { fence: 7 }, params: { provider: 'claude' }, journal: restingJournal() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the full reader uses only these context members; provider operations use the actual adapter.
  const context = {
    deps: {
      adapter,
      agents: claudeAndCodexAgents(),
      store: hostTestOptionsReadStore(() => record)
    },
    serialize: (id: string, task: () => Promise<unknown>) => queue.serialize(id, task),
    openConversation: async () => live,
    conversation: async () => live
  } as unknown as StructuredAgentSessionMutationContext
  const read = () =>
    readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
  try {
    claudeFrame(connection, { type: 'result', subtype: 'success', result: 'done', is_error: false })
    await vi.waitFor(() => expect(settings).toHaveBeenCalledOnce())
    expect((await read()).current.effort).toBe('high')
    await queue.serialize(SESSION, () =>
      adapter.dispatch({
        sessionId: SESSION,
        fence: 7,
        clientMessageId: 'while-reporting',
        body: USER_MESSAGE
      })
    )
    expect(connection.sent.length).toBeGreaterThan(0)
    await queue.serialize(SESSION, () =>
      adapter.setOption({ sessionId: SESSION, fence: 7, key: 'model', value: 'claude-opus-5' })
    )
    pending.resolve({
      applied: { model: 'old', effort: 'max' },
      effective: { effortLevel: 'max', fastMode: true }
    })
    await Promise.resolve()
    await Promise.resolve()
    expect((await read()).current).toMatchObject({ model: 'claude-opus-5', effort: 'high' })
    settings.mockResolvedValueOnce({
      applied: { model: 'claude-opus-5', effort: 'low' },
      effective: { effortLevel: 'low', fastMode: true }
    })
    claudeFrame(connection, {
      type: 'result',
      subtype: 'success',
      result: 'later',
      is_error: false
    })
    await vi.waitFor(async () =>
      expect((await read()).current).toMatchObject({ effort: 'low', fastMode: true })
    )
    expect(
      events.some(
        (event) => event.type === 'options-reported' && event.reportedOptions.effort === 'max'
      )
    ).toBe(false)
  } finally {
    pending.resolve(null)
    await adapter.closeSession(SESSION)
  }
})
