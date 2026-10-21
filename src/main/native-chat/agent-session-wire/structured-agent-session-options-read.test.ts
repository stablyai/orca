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

type RestingFacts = Pick<Partial<AgentSessionRecord>, 'options'> & {
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
    expect(read).toHaveBeenCalledTimes(1)
    const older = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: false
    })
    // A new chat that has sent nothing runs that default, which its first send pins.
    expect(older.current).toEqual({
      model: 'gpt-account',
      defaulted: [],
      permissionMode: 'ask'
    })
    expect(read).toHaveBeenLastCalledWith({ agent: 'codex', sessionId: SESSION, savedOnly: true })
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

  it.each(['codex', 'omp', 'grok', 'opencode'] as const)(
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
        defaulted: [],
        ...(provider === 'codex' ? { permissionMode: 'ask' } : {})
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
  const catalog = (models = listed) => ({
    read: async () => ({ origin: 'probe' as const, models, fetchedAt: 1 })
  })
  function readAtRest(
    facts: RestingFacts,
    items: AgentJournalItemBody[] = [],
    wroteBeforeOpen = false,
    models = listed
  ) {
    const record = { ...restingRecord(), ...facts }
    const resting = {
      child: null,
      params: { provider: 'codex' },
      journal: restingJournal(items, wroteBeforeOpen)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: {},
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => record },
        modelCatalog: catalog(models)
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
  function picking(options: Record<string, string>, models = efforts) {
    let record: AgentSessionRecord = { ...restingRecord(), options }
    const store = {
      getRecord: () => record,
      replaceSessionOptions: vi.fn(),
      reviseSessionOptions: async <A>(
        revise: (held: AgentSessionRecord, args: A) => AgentSessionRecord,
        args: A
      ) => (record = revise(record, args))
    }
    const deps = { store, agents: claudeAndCodexAgents(), modelCatalog: catalog(models) }
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
})

describe('live Codex option reads', () => {
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
