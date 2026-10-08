import { describe, expect, it } from 'vitest'
import { AgentHookServer } from '../server'
import type { AgentHookStatusRowMutation, EnrichedAgentHookEventPayload } from './server-types'

const PANE_KEY = 'tab-row:55555555-5555-4555-8555-555555555555'

class RowMutationProbe extends AgentHookServer {
  readonly mutations: AgentHookStatusRowMutation[] = []

  constructor() {
    super()
    this.subscribeStatusRowMutations((mutation) => this.mutations.push(mutation))
  }

  commit(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined
  ): boolean {
    return this.commitStatusRowMutation(before, after)
  }
}

function row(
  overrides: Partial<EnrichedAgentHookEventPayload> = {}
): EnrichedAgentHookEventPayload {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-row',
    worktreeId: 'worktree',
    connectionId: null,
    receivedAt: 1_000,
    stateStartedAt: 900,
    terminalHandle: 'term_row',
    ...overrides,
    payload: {
      state: 'working',
      prompt: 'ship it',
      agentType: 'opencode',
      lastAssistantMessage: 'x'.repeat(8_000),
      subagents: [{ id: 'child-1', state: 'working', agentType: 'claude', startedAt: 800 }],
      ...overrides.payload
    }
  }
}

describe('status-row change detection', () => {
  it('ignores a rebuilt row whose published content is identical', () => {
    const probe = new RowMutationProbe()
    const before = row()
    const rebuilt = row({
      receivedAt: 2_000,
      evidenceObservedAt: 1_500,
      launchToken: 'launch-2',
      promptInteractionKey: 'turn-2',
      observation: {
        origin: 'hook',
        authorityId: 'authority',
        incarnation: 1,
        revision: 7,
        observedAt: 2_000
      },
      payload: { ...before.payload, subagents: before.payload.subagents?.map((s) => ({ ...s })) }
    })
    expect(probe.commit(before, rebuilt)).toBe(false)
    expect(probe.mutations).toEqual([])
  })

  it('ignores key order, which a producer is free to change', () => {
    const probe = new RowMutationProbe()
    const before = row()
    const reordered: EnrichedAgentHookEventPayload = {
      payload: {
        subagents: before.payload.subagents?.map((s) => ({ ...s })),
        lastAssistantMessage: before.payload.lastAssistantMessage,
        agentType: before.payload.agentType,
        prompt: before.payload.prompt,
        state: before.payload.state
      },
      terminalHandle: before.terminalHandle,
      stateStartedAt: before.stateStartedAt,
      receivedAt: before.receivedAt,
      connectionId: before.connectionId,
      worktreeId: before.worktreeId,
      tabId: before.tabId,
      paneKey: before.paneKey
    }
    expect(probe.commit(before, reordered)).toBe(false)
  })

  // Why: paired clients read the whole payload off session.tabs, so no field may be skipped.
  it.each<[string, Partial<EnrichedAgentHookEventPayload>]>([
    ['state', { payload: { state: 'done', prompt: 'ship it' } }],
    [
      'lastAssistantMessage',
      { payload: { state: 'working', prompt: 'ship it', lastAssistantMessage: 'y' } }
    ],
    [
      'subagents',
      {
        payload: {
          state: 'working',
          prompt: 'ship it',
          subagents: [{ id: 'child-1', state: 'idle', agentType: 'claude', startedAt: 800 }]
        }
      }
    ],
    [
      'a newly present payload field',
      { payload: { state: 'working', prompt: 'ship it', model: 'm' } }
    ],
    ['stateStartedAt', { stateStartedAt: 950 }],
    ['connectionId', { connectionId: 'ssh-a' }],
    ['terminalHandle', { terminalHandle: 'term_other' }],
    ['providerSession', { providerSession: { key: 'session_id', id: 's-1' } }],
    ['structuredHost', { structuredHost: 'owned' }]
  ])('publishes a change to %s', (_field, overrides) => {
    const probe = new RowMutationProbe()
    const before = row()
    expect(probe.commit(before, row(overrides))).toBe(true)
    expect(probe.mutations).toEqual([
      {
        before: { paneKey: PANE_KEY, worktreeId: 'worktree', terminalHandle: 'term_row' },
        after: expect.objectContaining({ paneKey: PANE_KEY })
      }
    ])
  })

  it('publishes a row appearing or disappearing', () => {
    const probe = new RowMutationProbe()
    expect(probe.commit(null, row())).toBe(true)
    expect(probe.commit(row(), undefined)).toBe(true)
    expect(probe.mutations).toHaveLength(2)
  })
})
