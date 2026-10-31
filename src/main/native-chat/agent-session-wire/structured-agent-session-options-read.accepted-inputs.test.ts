import { CODEX_SESSION_OPTION_CATALOG } from '../../../shared/agent-session-option-catalog-claude-codex'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionOptionView
} from '../../../shared/structured-agent-session-option-view'
import { claudeOpened } from '../../claude/claude-structured-startup-settled-test-support'

import type { ClaudeStructuredSessionEvent } from '../../claude/structured/claude-structured-session-state'

import {
  acquired,
  fakeClaude,
  claudeFrame,
  USER_MESSAGE
} from '../../claude/claude-structured-session-test-support'

import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'

import { expect, it, vi } from 'vitest'
import {
  hostTestCatalogReadOperation,
  hostTestRestingOptionsRecord as restingRecord,
  HOST_TEST_RESTING_OPTIONS_CREATED_LINKS as created,
  hostTestRestingOptionsJournal as restingJournal,
  hostTestOptionsReadStore
} from './structured-agent-session-host-test-data'

import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'

import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'

import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

import {
  claudeAndCodexAgents,
  NO_STRUCTURED_AGENTS
} from './structured-agent-session-adapter-router-test-support'

const SESSION = 'session-1'

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
      expect((await read()).current).toMatchObject({ effort: 'low', fastMode: false })
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

it('uses Off for unpicked Claude Fast at rest and over a native On report, preserving explicit true and false', async () => {
  const record = {
    ...restingRecord(),
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/homes/a' }
  }
  const live = vi.fn(async () => ({ models: [], current: { model: 'opus', fastMode: true } }))
  const session = {
    params: { provider: 'claude' },
    child: { phase: 'starting', fence: 1 },
    journal: restingJournal()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies all fields the effective options reader uses.
  const context = {
    deps: {
      adapter: { readOptions: live },
      agents: claudeAndCodexAgents(),
      store: hostTestOptionsReadStore(() => record)
    },
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => session,
    conversation: async () => session
  } as unknown as StructuredAgentSessionMutationContext
  const starting = await readStructuredAgentSessionOptions(context, SESSION, {
    readsWithoutModel: true
  })
  expect(starting.current.fastMode).toBe(false)
  expect(live).not.toHaveBeenCalled()
  expect(starting.current.acceptedInputSources).toEqual({ fastMode: 'policy' })
  session.child.phase = 'ready'
  expect(
    (await readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })).current
      .fastMode
  ).toBe(false)
  for (const fastMode of ['true', 'false']) {
    record.options = { fastMode }
    const answer = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: true
    })
    expect(answer.current.acceptedInputSources).toEqual({ fastMode: 'saved' })
    expect(answer.current.fastMode).toBe(fastMode === 'true')
  }
})

it.each([false, true])(
  'captures accepted origins through host read and shared view, resumed=%s',
  async (resumed) => {
    const record = restingRecord()
    if (resumed) {
      record.providerHandleChain = [{ ...created[0]!, origin: 'adopted' }]
    }
    const models: AgentSessionModelOption[] = [
      {
        id: 'opus[1m]',
        label: 'Alias',
        isDefault: false,
        efforts: [{ value: 'high', label: 'High' }],
        serviceTiers: [{ value: 'priority', label: 'Fast' }]
      },
      {
        id: 'other',
        label: 'Other',
        isDefault: false,
        efforts: [],
        serviceTiers: [{ value: 'flex', label: 'Flex' }]
      }
    ]
    const session = {
      child: { fence: 1 },
      params: { provider: 'codex' },
      journal: restingJournal()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the fields used by the options read.
    const context = {
      deps: {
        adapter: {
          readOptions: async () => ({
            models,
            current: { model: 'opus[1m]', effort: 'high', confirmed: ['model', 'effort'] }
          })
        },
        modelCatalog: {
          captureRead: hostTestCatalogReadOperation,
          read: async () => ({ origin: 'probe', fetchedAt: 1, models })
        },
        agents: NO_STRUCTURED_AGENTS,
        store: hostTestOptionsReadStore(() => record)
      },
      serialize: (_id: string, task: () => Promise<unknown>) => task(),
      openConversation: async () => session,
      conversation: async () => session
    } as unknown as StructuredAgentSessionMutationContext
    const capture = async () => {
      const answer = await readStructuredAgentSessionOptions(context, SESSION, {
        readsWithoutModel: true
      })
      const state = applyStructuredAgentSessionOptions(
        createStructuredAgentSessionOptionState('codex'),
        CODEX_SESSION_OPTION_CATALOG,
        answer,
        { newLaunch: !resumed }
      )
      return {
        answer,
        selection: structuredAgentSessionMessageSelection(
          structuredAgentSessionOptionView(state, undefined, {})
        )
      }
    }
    const initial = await capture()
    expect(initial.answer.current.acceptedInputSources).toEqual({})
    expect(initial.selection).toEqual({})
    for (const model of ['opus[1m]', 'retired-unlisted']) {
      record.options = { model, effort: 'high', serviceTier: 'flex' }
      const captured = await capture()
      expect(captured.answer.current.acceptedInputSources).toEqual({
        model: 'saved',
        effort: 'saved',
        serviceTier: 'saved'
      })
      expect(captured.selection).toEqual({
        model,
        effort: 'high',
        serviceTier: model === 'opus[1m]' ? 'default' : 'flex'
      })
    }
  }
)
