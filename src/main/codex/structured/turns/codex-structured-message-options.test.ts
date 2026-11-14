import {
  compileCodexMessageOptions,
  structuredMessageSteeringOptionsDiffer
} from '../../../../shared/agent-session/options/codex-message-compiler'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../../shared/agent-session/options/structured-agent-session-options'
import { structuredAgentSessionMessageSelection } from '../../../../shared/agent-session/options/view/structured-agent-session-option-view'
import { captureStructuredExecutionOptions } from '../../../native-chat/agent-session-wire/options/structured-agent-session-execution-options'
import { claudeAndCodexAgents } from '../../../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { AgentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { optionSession } from '../catalog/codex-structured-option-session.test-fixture'
import {
  readCodexAppliedInputOptions,
  readCodexMessageSteeringInputs,
  resolvedCodexMessageOptions
} from './codex-structured-message-options'
import {
  codexTurnOptionsDiffer,
  waitsForCodexTurnOptions
} from '../../../native-chat/agent-session-wire/options/structured-agent-session-message-options'
import { startCodexTurn } from './codex-structured-turn-start'
import { CodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import { CodexAppliedSettings } from '../catalog/codex-structured-applied-settings'
import { changeCodexThreadGoalWithSettings } from '../threads/codex-structured-thread-goal'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import {
  USER_MESSAGE,
  fakeCodex,
  adapterFor,
  acquireReadyCodexForTest,
  identityFor,
  answerWithOpenedTurn
} from '../session-lifecycle/codex-structured-session-adapter-fixture'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'

function seedMessageDefaults(session: CodexSession): void {
  const store = new AgentModelCatalogStore()
  const fingerprint = 'codex-message-defaults'
  store.recordSuccess(
    fingerprint,
    'codex',
    {
      origin: 'probe',
      models: [
        {
          id: 'model-a',
          label: 'Model A',
          isDefault: false,
          defaultEffort: 'low',
          serviceTiers: [{ value: 'priority', label: 'Fast' }],
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        },
        {
          id: 'model-b',
          label: 'Model B',
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    },
    'discovery'
  )
  session.catalogAccess = { store, fingerprint, accountHomePath: '/test-account' }
}

describe('Codex captured message choices', () => {
  it('restores native options after a known refusal and retains them after an unknown answer', async () => {
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }
    const known = optionSession(
      vi.fn(async () => {
        throw new CodexAppServerRequestError('turn/start', -32602, 'invalid model')
      })
    )
    known.options.set('model', 'prior')
    known.appliedTurnOptions = { model: 'prior', effort: 'low', serviceTier: 'flex' }
    await expect(
      startCodexTurn(known, { clientMessageId: 'known', body, turnOptions: { model: 'attempted' } })
    ).rejects.toThrow('invalid model')
    expect(Object.fromEntries(known.options)).toEqual({ model: 'prior' })
    expect(known.appliedTurnOptions).toEqual({ model: 'prior', effort: 'low', serviceTier: 'flex' })
    const unknown = optionSession(
      vi.fn(async () => {
        throw new Error('connection lost after write')
      })
    )
    unknown.options.set('model', 'prior')
    unknown.appliedTurnOptions = { model: 'prior', effort: 'low', serviceTier: 'flex' }
    await expect(
      startCodexTurn(unknown, {
        clientMessageId: 'unknown',
        body,
        turnOptions: { model: 'attempted' }
      })
    ).rejects.toThrow('connection lost after write')
    expect(Object.fromEntries(unknown.options)).toEqual({ model: 'attempted' })
    expect(unknown.appliedTurnOptions).toEqual({
      effort: 'low',
      serviceTier: 'flex'
    })
  })
})

it.each([true, false])(
  'sends delayed client literal with accepted effort=%s after another client changes the host tuple',
  async (acceptedEffort) => {
    const literal = 'retired-literal'
    const model = {
      id: 'model-b',
      label: 'Model B',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    }
    const clientA = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [model],
        current: {
          model: literal,
          effort: 'high',
          confirmed: ['model', 'effort'],
          defaulted: [],
          acceptedInputSources: {
            model: 'saved',
            ...(acceptedEffort ? { effort: 'saved' as const } : {})
          }
        }
      }
    )
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
      method === 'turn/start' ? { turn: { id: 'literal-turn' } } : { config: {} }
    )
    const session = optionSession(request)
    seedMessageDefaults(session)
    session.options = new Map([
      ['model', model.id],
      ['effort', 'high']
    ])
    session.reportedOptions = { model: model.id, effort: 'high' }
    session.appliedTurnOptions = { model: model.id, effort: 'high' }
    const expected = { model: literal, ...(acceptedEffort ? { effort: 'high' } : {}) }
    const captured = captureStructuredExecutionOptions(
      {
        agents: claudeAndCodexAgents(),
        agent: 'codex',
        persistedOptions: { model: model.id, effort: 'high' }
      },
      undefined,
      structuredAgentSessionMessageSelection(clientA)
    )
    if ('refusal' in captured) {
      throw new Error('accepted snapshot was refused')
    }
    expect(captured.options).toEqual(expected)
    const turnOptions = await resolvedCodexMessageOptions(session, captured.options)
    expect(turnOptions).toEqual(expected)
    expect(Object.fromEntries(session.options)).toEqual({ model: model.id, effort: 'high' })
    await startCodexTurn(session, {
      clientMessageId: 'delayed-client',
      body: USER_MESSAGE,
      turnOptions
    })
    const turn = request.mock.calls.filter(([method]) => method === 'turn/start')
    expect(turn).toHaveLength(1)
    expect(turn[0]?.[1]).toMatchObject({
      threadId: 'thread-1',
      clientUserMessageId: 'delayed-client',
      ...expected
    })
    if (!acceptedEffort) {
      expect(turn[0]?.[1]).not.toHaveProperty('effort')
    }
  }
)

it('sends native Plan and Build on fresh turns while a steer keeps its running mode', async () => {
  const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
    turn: { id: 'mode-turn' }
  }))
  const session = optionSession(request)
  session.reportedOptions = { model: 'retired-model', effort: 'high' }
  session.appliedTurnOptions = undefined
  for (const [id, interactionMode] of [
    ['plan', 'plan'],
    ['build', 'default']
  ]) {
    session.activeTurnIds = new Set()
    await startCodexTurn(session, {
      clientMessageId: id!,
      body: USER_MESSAGE,
      turnOptions: { interactionMode: interactionMode! }
    })
    expect(request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'turn/start',
      expect.objectContaining({
        collaborationMode: {
          mode: interactionMode,
          settings: {
            model: 'retired-model',
            reasoning_effort: 'high',
            developer_instructions: null
          }
        }
      })
    ])
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty('interactionMode')
  }
  session.activeTurnIds = new Set(['mode-turn'])
  await startCodexTurn(session, {
    clientMessageId: 'steer-plan',
    body: USER_MESSAGE,
    turnOptions: { interactionMode: 'plan' }
  })
  expect(request.mock.calls.at(-1)?.[0]).toBe('turn/steer')
  expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty('collaborationMode')
})

it.each(['priority', 'default'])(
  'keeps the same priority input eligible after an actual %s start and catalog change',
  async (initialTier) => {
    const request = vi.fn(async () => ({ turn: { id: 'tier-turn' } }))
    const session = optionSession(request)
    const store = new AgentModelCatalogStore()
    const catalog = (priority: boolean) =>
      store.recordSuccess(
        'input-intent',
        'codex',
        {
          origin: 'probe',
          models: [
            {
              id: 'gpt-live',
              label: 'GPT',
              isDefault: true,
              efforts: [{ value: 'high', label: 'High' }],
              serviceTiers: priority ? [{ value: 'priority', label: 'Fast' }] : []
            }
          ]
        },
        'discovery'
      )
    session.catalogAccess = { store, fingerprint: 'input-intent', accountHomePath: '/test-account' }
    session.reportedOptions = { model: 'gpt-live', effort: 'high', serviceTier: 'default' }
    catalog(initialTier === 'priority')
    const choices = { model: 'gpt-live', effort: 'high', serviceTier: 'priority' }
    await startCodexTurn(session, {
      clientMessageId: 'priority-input',
      body: USER_MESSAGE,
      executionOptions: choices,
      turnOptions: await resolvedCodexMessageOptions(session, choices)
    })
    expect(request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        serviceTier: initialTier
      }),
      expect.anything()
    )
    catalog(false)
    const differs = (next: Record<string, string>) =>
      codexTurnOptionsDiffer(
        { provider: 'codex', sessionId: 'session-1' },
        next,
        { fence: 1, generation: 'generation-1', phase: 'ready' },
        { captureMessageSteeringInputs: (input) => readCodexMessageSteeringInputs(session, input) }
      )
    expect(differs(choices)).toBe(false)
    expect(differs({ ...choices, serviceTier: 'default' })).toBe(true)
  }
)

it('holds Plan behind a successful sparse Default start, then starts Plan after completion', async () => {
  const codex = fakeCodex()
  const adapter = adapterFor(codex)
  const bodies: AgentJournalItemBody[] = []
  const acquisition = await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn',
    events: {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const dispatch = (id: string, options: Record<string, string>) =>
    adapter.dispatch({
      sessionId: 'session-1',
      fence: 7,
      clientMessageId: id,
      body: USER_MESSAGE,
      executionOptions: options
    })
  const complete = (turnId: string) =>
    codex.connections[0].handlers.onNotification?.('turn/completed', {
      threadId: 'thread-abc',
      turn: { id: turnId, status: 'completed' }
    })
  const held = (interactionMode: 'default' | 'plan') =>
    waitsForCodexTurnOptions(
      { provider: 'codex', sessionId: 'session-1' },
      {
        reads: {
          messageOptions: async () => ({
            ordinaryMessage: true,
            runningTurn: bodies.findLast((body) => body.kind === 'turn')?.state === 'running'
          })
        }
      },
      {
        clientMessageId: 'next-plan',
        fence: 7,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null,
        options: { interactionMode }
      },
      { fence: 7, generation: acquisition.acquisitionGeneration, phase: 'ready' },
      adapter
    )
  try {
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'plan-first')
    expect(await dispatch('first', { interactionMode: 'plan' })).toMatchObject({
      state: 'admitted'
    })
    complete('plan-first')
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'default-second')
    expect(await dispatch('second', {})).toMatchObject({ state: 'admitted' })
    expect(
      codex.connections[0].calls.findLast((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ collaborationMode: { mode: 'default' } })
    expect(await held('plan')).toBe(true)
    expect(await held('default')).toBe(false)
    complete('default-second')
    expect(await held('plan')).toBe(false)
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'plan-third')
    expect(await dispatch('third', { interactionMode: 'plan' })).toMatchObject({
      state: 'admitted'
    })
    expect(
      codex.connections[0].calls.findLast((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ collaborationMode: { mode: 'plan' } })
  } finally {
    await adapter.closeAll()
  }
})

it('uses exact successful start controls when the first message omits model and effort', async () => {
  const session = optionSession(vi.fn(async () => ({ turn: { id: 'first-turn' } })))
  await startCodexTurn(session, {
    clientMessageId: 'first',
    body: USER_MESSAGE,
    executionOptions: {},
    turnOptions: {}
  })
  const read = (next: Record<string, string>) =>
    readCodexAppliedInputOptions(session, {
      fence: 1,
      acquisitionGeneration: 'generation-1',
      next
    })
  expect(read({ effort: 'high' })).toMatchObject({
    active: { model: 'gpt-live', effort: 'high' },
    next: { model: 'gpt-live', effort: 'high' }
  })
  expect(read({ effort: 'low' })).toMatchObject({
    active: { effort: 'high' },
    next: { effort: 'low' }
  })
})

it('inherits retained sparse intent ahead of canonical execution controls', async () => {
  const session = optionSession(vi.fn(async () => ({ turn: { id: 'sparse-turn' } })))
  session.appliedTurnOptions = { model: 'gpt-canonical', effort: 'high' }
  session.appliedTurnInputOptions = { model: 'gpt-alias', effort: 'low' }
  const choices = { model: 'gpt-alias' }
  await startCodexTurn(session, {
    clientMessageId: 'sparse',
    body: USER_MESSAGE,
    executionOptions: choices,
    turnOptions: await resolvedCodexMessageOptions(session, choices)
  })
  expect(
    readCodexAppliedInputOptions(session, {
      fence: 1,
      acquisitionGeneration: 'generation-1',
      next: { model: 'gpt-alias', effort: 'low' }
    })
  ).toMatchObject({
    active: { model: 'gpt-alias', effort: 'low' },
    next: { model: 'gpt-alias', effort: 'low' }
  })
})

it('retains legacy fast intent as the successful native tier after a standard turn', async () => {
  const session = optionSession(vi.fn(async () => ({ turn: { id: 'fast-turn' } })))
  seedMessageDefaults(session)
  session.appliedTurnInputOptions = { model: 'model-a', serviceTier: 'default' }
  const choices = { model: 'model-a', fastMode: 'true' as const }
  await startCodexTurn(session, {
    clientMessageId: 'legacy-fast',
    body: USER_MESSAGE,
    executionOptions: choices,
    turnOptions: await resolvedCodexMessageOptions(session, choices)
  })
  expect(Object.fromEntries(session.options)).toEqual({ model: 'model-a', serviceTier: 'priority' })
  expect(
    readCodexAppliedInputOptions(session, {
      fence: 1,
      acquisitionGeneration: 'generation-1',
      next: { serviceTier: 'priority' }
    })
  ).toMatchObject({ active: { serviceTier: 'priority' }, next: { serviceTier: 'priority' } })
})

it('invalidates uncertain goal choices independently from shaped execution evidence', async () => {
  const session = optionSession(
    vi.fn(async () => {
      throw new Error('lost after write')
    })
  )
  session.appliedSettings = new CodexAppliedSettings()
  session.appliedSettings.observe({ model: 'gpt-canonical', effort: 'high' })
  session.appliedTurnOptions = { model: 'gpt-canonical', effort: 'high' }
  session.appliedTurnInputOptions = { model: 'gpt-alias', effort: 'low', serviceTier: 'default' }
  expect(
    await changeCodexThreadGoalWithSettings(
      session,
      {
        sessionId: 'session-1',
        fence: 1,
        change: { kind: 'set', objective: 'Ship it' },
        replacesGoal: false,
        executionOptions: { model: 'gpt-canonical', effort: 'low' }
      },
      1000,
      () => true
    )
  ).toMatchObject({ ok: false })
  expect(
    readCodexAppliedInputOptions(session, {
      fence: 1,
      acquisitionGeneration: 'generation-1',
      next: {}
    })?.active
  ).toEqual({ effort: 'low', serviceTier: 'default' })
})

it('compiles copied live steering inputs with exact sparse defaults and tier semantics', async () => {
  const session = optionSession(vi.fn(async () => ({})))
  seedMessageDefaults(session)
  session.options = new Map([['effort', 'high']])
  session.appliedTurnOptions = { model: 'model-a', effort: 'low', serviceTier: 'default' }
  session.appliedTurnInputOptions = { ...session.appliedTurnOptions }
  const binding = { fence: 1, acquisitionGeneration: 'generation-1' }
  const input = readCodexMessageSteeringInputs(session, binding)
  if (input.kind !== 'codex') {
    throw new Error('missing live inputs')
  }
  expect(structuredMessageSteeringOptionsDiffer(input, undefined)).toBe(true)
  expect(structuredMessageSteeringOptionsDiffer(input, {})).toBe(false)
  expect(await resolvedCodexMessageOptions(session, undefined)).toBeUndefined()
  expect(
    compileCodexMessageOptions(input.compiler, { model: 'model-a', fastMode: 'true' })
  ).toEqual({ model: 'model-a', serviceTier: 'priority' })
  expect(
    compileCodexMessageOptions(input.compiler, { model: 'model-b', fastMode: 'true' })
  ).toEqual({ model: 'model-b', serviceTier: 'fast' })
  expect(
    compileCodexMessageOptions(input.compiler, {
      model: 'model-a',
      fastMode: 'true',
      serviceTier: 'priority'
    })
  ).toEqual({ model: 'model-a', serviceTier: 'priority' })
  session.reportedOptions.serviceTier = 'configured'
  const configured = readCodexMessageSteeringInputs(session, binding)
  if (configured.kind !== 'codex') {
    throw new Error('missing configured inputs')
  }
  expect(compileCodexMessageOptions(configured.compiler, { serviceTier: 'configured' })).toEqual({
    serviceTier: 'configured'
  })
  expect(
    readCodexAppliedInputOptions(session, { ...binding, next: { serviceTier: 'configured' } })?.next
  ).toEqual({ model: 'model-a', effort: 'low', serviceTier: 'configured' })
  session.options.set('effort', 'low')
  session.appliedTurnOptions = { model: 'model-b', effort: 'high' }
  expect(input.compiler.active).toEqual({ model: 'model-a', effort: 'low', serviceTier: 'default' })
  expect(structuredMessageSteeringOptionsDiffer(input, undefined)).toBe(true)
  expect(readCodexMessageSteeringInputs(session, { ...binding, fence: 2 })).toEqual({
    kind: 'codex-unavailable'
  })
  expect(structuredMessageSteeringOptionsDiffer({ kind: 'codex-unavailable' }, undefined)).toBe(
    false
  )
  expect(structuredMessageSteeringOptionsDiffer({ kind: 'codex-unavailable' }, {})).toBe(false)
  expect(structuredMessageSteeringOptionsDiffer({ kind: 'other' }, { effort: 'high' })).toBe(false)
})
