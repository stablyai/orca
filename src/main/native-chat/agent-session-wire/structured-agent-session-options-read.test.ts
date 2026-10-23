import { structuredAgentSessionCapabilityView } from './structured-agent-session-option-models'
import { claudeFallbackModelOptions } from '../../claude/claude-structured-session-options'
import { acquired, fakeClaude } from '../../claude/claude-structured-session-test-support'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import { structuredAgentSessionSendSelection } from '../../../shared/structured-agent-session-option-view'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
// A chat's options at rest come from the host catalog without waiting on a listing.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session-rewind'
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
import { recordAgentSessionRanOptions } from '../../runtime/agent-session-record-options'
import {
  claudeAndCodexAgents,
  NO_STRUCTURED_AGENTS
} from './structured-agent-session-adapter-router-test-support'

const SESSION = 'session-1'

type RestingFacts = Pick<Partial<AgentSessionRecord>, 'options' | 'provider'> & {
  providerHandleChain?: Pick<AgentSessionProviderHandleLink, 'origin'>[]
  rewind?: Pick<AgentSessionRewindRecord, 'phase'>
}

function restingJournal(items: AgentJournalItemBody[] = [], wroteBeforeOpen = false) {
  return {
    threadGoal: () => null,
    visitItems: (visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void) =>
      items.forEach((body, index) => visit(`item-${index}`, index + 1, body)),
    wroteBeforeOpen: () => wroteBeforeOpen,
    submissions: () => [],
    contextUsage: () => null,
    context: { floor: () => null }
  }
}

function restingRecord(): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and the catalog key touch only these fields.
  return {
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/homes/a' },
    providerHandleChain: [],
    location: { executionHostId: 'local', wslDistro: null },
    lease: { claimStatus: 'released', ownerProcess: null, runtimeFence: 1 },
    options: {}
  } as unknown as AgentSessionRecord
}

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
        store: { getRecord: () => record },
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
    // A new chat that has sent nothing runs that default, which its first send pins.
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

  it("names the saved listing's ids and model for a live child that fell back to its default", async () => {
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
        store: { getRecord: () => record },
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
    // The saved model shows over the child's fallback, and is the chat's own.
    expect(running.current).toMatchObject({ model: 'gpt-unlisted', defaulted: [] })
  })

  it.each(['omp', 'grok', 'opencode'] as const)(
    '%s keeps an unknown model and learns menus from later options',
    async (provider) => {
      const record = { ...restingRecord(), provider }
      const probe = vi.fn(() => new Promise<AgentModelCatalogSuccess>(() => {}))
      const modelCatalog = createAgentModelCatalogService({
        store: new AgentModelCatalogStore(),
        getRecord: () => record,
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
          store: { getRecord: () => record },
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
      // Only Codex is registered here, and a mode is stated only for a registered agent's chat.
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
        live = false
        const answer = await read()
        expect(answer.models).toEqual(reader.read().models)
      }
    }
  )
})

describe('a chat at rest, read by the host', () => {
  const created: RestingFacts['providerHandleChain'] = [{ origin: 'created' }]
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
        store: { getRecord: () => record },
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
    ['taken from history', { providerHandleChain: [{ origin: 'adopted' }] }, [], true, ['model']],
    // A context clear hides the turn from the newest-turn read, not from history.
    ['with a turn before a context clear', {}, [turn], true, ['model']],
    ['after a rewind', { rewind: { phase: 'completed' } }, [], true, ['model']],
    // A journal founded afresh proves nothing for a chat whose agent already ran.
    ['whose journal went missing', { providerHandleChain: created }, [], false, ['model']]
  ])('%s', async (_name, facts, items, wroteBeforeOpen, defaulted) => {
    const read = await readAtRest(facts, items, wroteBeforeOpen)
    expect(read.current).toMatchObject({ model: 'gpt-account', defaulted })
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
    expect(await chat.pick('effort', 'low')).toMatchObject({ ok: false })
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
      { provider: 'claude', providerHandleChain: [{ origin: 'adopted' }] },
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
    // Codex lists no Flex; a Flex from the user's config runs as configured.
    ['no model lists', listed.slice(0, 1), 'flex']
  ])(
    'names the tier the model runs where %s it, and keeps the saved one',
    async (_n, models, runs) => {
      const options = { model: 'gpt-account', serviceTier: 'flex' }
      const answer = await readAtRest({ options }, [], false, models)
      expect(answer.current).toMatchObject({ serviceTier: runs })
      const chat = picking(options, models)
      expect(await chat.pick('model', 'gpt-account')).toMatchObject({
        value: { options: { serviceTier: runs } }
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
      getRecord: () => record,
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
      record: () => record
    }
  }

  it('admits options only under the model the chat runs, whichever write lands first', async () => {
    const chat = picking({ model: 'a', effort: 'high' })
    // A model pick drops an inherited effort its row does not offer; an offered one is refused.
    await chat.pick('model', 'c')
    expect(chat.record().options).toEqual({ model: 'c' })
    expect(await chat.pick('effort', 'high')).toMatchObject({ ok: false })
    await chat.pick('model', 'b')
    // A turn that ran on another model, recorded late, fills nothing, though b offers its effort.
    expect(chat.ran('a', { effort: 'high' }).options).toEqual({ model: 'b' })
    expect(chat.ran('b', { effort: 'high' }).options).toEqual({ model: 'b', effort: 'high' })
    // A catalog that later drops it, or a pick, keeps the saved value.
    chat.ran('b', { effort: 'low' }, [])
    await chat.pick('serviceTier', 'priority')
    expect(chat.record().options).toEqual({ model: 'b', effort: 'high', serviceTier: 'priority' })
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

  it('keeps newer saved picks after a cold live listing waits without holding the session lane', async () => {
    const listing = Promise.withResolvers<void>()
    const queue = new StructuredAgentSessionTaskQueue()
    const record = { ...restingRecord(), options: { model: 'gpt-picked', effort: 'high' } }
    const child = { fence: 7 }
    const apply = vi.fn(() => ({
      models: [{ id: 'gpt-live', label: 'GPT Live', efforts: [] }],
      current: { model: 'gpt-live', effort: 'high', confirmed: ['model', 'effort'] as const }
    }))
    const prepareReadOptions = vi.fn(async () => {
      await listing.promise
      return apply
    })
    const live = {
      child,
      params: { provider: 'codex' },
      journal: restingJournal()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: { prepareReadOptions },
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => record }
      },
      serialize: (sessionId: string, task: () => Promise<unknown>) =>
        queue.serialize(sessionId, task),
      openConversation: async () => live,
      conversation: async () => live
    } as unknown as StructuredAgentSessionMutationContext

    const reading = readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: false
    })
    await vi.waitFor(() =>
      expect(prepareReadOptions).toHaveBeenCalledWith({ sessionId: SESSION, fence: 7 })
    )
    await expect(queue.serialize(SESSION, async () => 'delivery can proceed')).resolves.toBe(
      'delivery can proceed'
    )
    expect(apply).not.toHaveBeenCalled()
    record.options = { model: 'gpt-next', effort: 'low' }
    listing.resolve()
    await expect(reading).resolves.toMatchObject({
      current: { model: 'gpt-next', effort: 'low' }
    })
    expect(apply).toHaveBeenCalledOnce()
  })

  it('keeps a listing failure visible to the picker', async () => {
    const queue = new StructuredAgentSessionTaskQueue()
    const live = {
      child: { fence: 7 },
      params: { provider: 'codex' },
      journal: restingJournal()
    }
    const failure = new Error('model/list unavailable')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the failed read ends before touching the remaining context fields.
    const context = {
      deps: {
        adapter: {
          prepareReadOptions: async () => {
            throw failure
          }
        },
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => restingRecord() }
      },
      serialize: (sessionId: string, task: () => Promise<unknown>) =>
        queue.serialize(sessionId, task),
      openConversation: async () => live
    } as unknown as StructuredAgentSessionMutationContext

    await expect(
      readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
    ).rejects.toBe(failure)
    await expect(queue.serialize(SESSION, async () => 'Stop can proceed')).resolves.toBe(
      'Stop can proceed'
    )
  })

  it('does not apply a listing to a replaced child', async () => {
    const listing = Promise.withResolvers<void>()
    const queue = new StructuredAgentSessionTaskQueue()
    const apply = vi.fn(() => ({ models: [], current: { model: 'stale' } }))
    const prepareReadOptions = vi.fn(async () => {
      await listing.promise
      return apply
    })
    const live = {
      child: { fence: 7 },
      params: { provider: 'codex' },
      journal: restingJournal()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: { prepareReadOptions },
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => restingRecord() }
      },
      serialize: (sessionId: string, task: () => Promise<unknown>) =>
        queue.serialize(sessionId, task),
      openConversation: async () => live,
      conversation: async () => live
    } as unknown as StructuredAgentSessionMutationContext

    const reading = readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
    await vi.waitFor(() => expect(prepareReadOptions).toHaveBeenCalledOnce())
    await queue.serialize(SESSION, async () => {
      live.child = { fence: 8 }
    })
    listing.resolve()
    expect((await reading).current).not.toHaveProperty('model')
    expect(apply).not.toHaveBeenCalled()
  })
})
