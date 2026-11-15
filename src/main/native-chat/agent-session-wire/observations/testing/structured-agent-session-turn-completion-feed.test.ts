import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { AgentSessionExecutionLocation } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentChildWorkLivenessCandidate } from '../../../../../shared/agent-status/child-work/agent-status-child-work-liveness'
import {
  StructuredAgentSessionTurnCompletionFeed,
  type StructuredAgentSessionTurnCompletionFeedDeps
} from '../structured-agent-session-turn-completion-feed'
import type { StructuredAgentSessionStatusState } from '../structured-agent-session-status-journal-projection'

const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'folder'
} as AgentSessionExecutionLocation

// Journal cursor the feed reads on each observe; sequence advances per observation.
function journal(sequence: number) {
  return { cursor: () => ({ epoch: 'e1', sequence }) }
}

function settledState(
  turnId: string,
  outcome: 'success' | 'failure'
): StructuredAgentSessionStatusState {
  return {
    summary: { status: 'idle', latestPrompt: '' },
    latestRequest: {
      kind: 'turn',
      id: turnId,
      turnState: 'completed',
      outcome,
      settledAt: 10
    },
    owesWork: false,
    pendingPromptIds: []
  } as unknown as StructuredAgentSessionStatusState
}

function runningState(): StructuredAgentSessionStatusState {
  return {
    summary: { status: 'working', latestPrompt: '' },
    latestRequest: {
      kind: 'turn',
      id: 't1',
      turnState: 'running',
      outcome: null,
      settledAt: undefined
    },
    owesWork: true,
    pendingPromptIds: []
  } as unknown as StructuredAgentSessionStatusState
}

function rig(options: {
  states: StructuredAgentSessionStatusState[]
  children: { current: readonly AgentChildWorkLivenessCandidate[] | undefined }
}) {
  const emitted: AgentSessionTurnCompletionEvent[] = []
  let read = 0
  const deps: StructuredAgentSessionTurnCompletionFeedDeps = {
    sessions: new Map([['session-a', { journal: journal(0), params: { location: LOCATION } }]]),
    now: () => 100,
    readStatusState: () => options.states[Math.min(read++, options.states.length - 1)] ?? null,
    readChildWork: () => options.children.current
  }
  const feed = new StructuredAgentSessionTurnCompletionFeed(deps)
  feed.subscribe({ id: 'owner', emit: (event) => emitted.push(event) })
  return { feed, emitted }
}

const completions = (events: AgentSessionTurnCompletionEvent[]) =>
  events.filter((event) => event.type === 'completion')

describe('structured turn completion feed: owner notification', () => {
  it('notifies exactly once when a held lead completes and its live child then settles', () => {
    const children = {
      current: [{ kind: 'agent', state: 'working' }] as AgentChildWorkLivenessCandidate[]
    }
    const { feed, emitted } = rig({
      states: [
        runningState(),
        settledState('t1', 'success'),
        settledState('t1', 'success'),
        settledState('t1', 'success')
      ],
      children
    })
    // Establish baseline while running; lead done but held by a live child must stay silent.
    feed.observe('session-a', undefined, { historical: true })
    feed.observe('session-a')
    feed.observe('session-a')
    expect(completions(emitted)).toHaveLength(0)
    // Child settles: lead completion is announced once, not again on repeated settled observations.
    children.current = [{ kind: 'agent', state: 'done' }]
    feed.observe('session-a')
    feed.observe('session-a')
    expect(completions(emitted)).toHaveLength(1)
    expect(completions(emitted)[0]).toMatchObject({
      completion: { sessionId: 'session-a', turnId: 't1', outcome: 'success' }
    })
  })

  it('never notifies for a settled turn that was already observed, nor for unknown outcome', () => {
    const { feed, emitted } = rig({
      states: [settledState('t1', 'success')],
      children: { current: [] }
    })
    feed.observe('session-a', undefined, { historical: true })
    feed.observe('session-a')
    feed.observe('session-a')
    expect(completions(emitted)).toHaveLength(0)
  })

  it('stops delivering to a subscriber after unsubscribe and sends a single end event', () => {
    const emit = vi.fn()
    const deps: StructuredAgentSessionTurnCompletionFeedDeps = {
      sessions: new Map([['session-a', { journal: journal(0), params: { location: LOCATION } }]]),
      now: () => 100,
      readStatusState: () => null,
      readChildWork: () => []
    }
    const feed = new StructuredAgentSessionTurnCompletionFeed(deps)
    const stop = feed.subscribe({ id: 'owner', emit })
    stop()
    stop()
    expect(emit.mock.calls).toEqual([[{ type: 'end' }]])
  })
})
