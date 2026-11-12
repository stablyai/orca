import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session/options/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../../shared/agent-session/options/structured-agent-session-options'
import { structuredAgentSessionMessageSelection } from '../../../../shared/agent-session/options/structured-agent-session-option-view'
import { captureStructuredExecutionOptions } from '../../../native-chat/agent-session-wire/options/structured-agent-session-execution-options'
import { claudeAndCodexAgents } from '../../../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router-test-support'
import { describe, expect, it, vi } from 'vitest'
import { AgentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { optionSession } from '../catalog/codex-structured-option-session.test-fixture'
import {
  readCodexAppliedInputOptions,
  resolvedCodexMessageOptions
} from './codex-structured-message-options'
import { codexTurnOptionsDiffer } from '../../../native-chat/agent-session-wire/options/structured-agent-session-message-options'
import { startCodexTurn } from './codex-structured-turn-start'
import { CodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import { USER_MESSAGE } from '../session-lifecycle/codex-structured-session-adapter-fixture'

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
          serviceTiers: [{ value: 'priority', label: 'Priority' }],
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
        { readAppliedInputOptions: (input) => readCodexAppliedInputOptions(session, input) }
      )
    expect(differs(choices)).toBe(false)
    expect(differs({ ...choices, serviceTier: 'default' })).toBe(true)
  }
)

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
      sessionId: 'session-1',
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
