import { expect, it } from 'vitest'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

const state = (id: string, owesWork = false): StructuredAgentSessionStatusState => ({
  latestRequest: { kind: 'turn', id, turnState: 'completed', outcome: 'success', settledAt: 1 },
  owesWork,
  pendingPromptIds: [],
  summary: { status: owesWork ? 'working' : 'idle', latestPrompt: '' }
})

function fixture() {
  const events: AgentSessionTurnCompletionEvent[] = []
  const sessions = new Map(
    ['one', 'two'].map((id) => [
      id,
      {
        journal: { cursor: () => ({ epoch: 'e', sequence: 0 }) },
        params: {
          location: {
            executionHostId: 'local' as const,
            wslDistro: null,
            workspaceId: 'wt',
            workspaceKind: 'git-worktree' as const
          }
        }
      }
    ])
  )
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    sessions,
    readStatusState: async () => null,
    readChildWork: () => undefined,
    now: () => 9
  })
  feed.subscribe({ id: 'test', emit: (event) => events.push(event) })
  let sequence = 0
  const observe = (
    value: StructuredAgentSessionStatusState,
    options: {
      epoch?: string
      historical?: boolean
      session?: string
    } = {}
  ) =>
    feed.observeProjection(
      options.session ?? 'one',
      {
        epoch: options.epoch ?? 'e',
        sequence: sequence++,
        state: value
      },
      { historical: options.historical }
    )
  return { events, feed, observe }
}

it('counts distinct held provider turns once, including repeated and batched observations', () => {
  const f = fixture()
  f.observe(state('baseline'))
  f.observe(state('a', true))
  f.observe(state('a', true))
  f.observe(state('b', true))
  f.observe(state('b', true))
  f.observe(state('c'))
  f.observe(state('c'))
  expect(f.events).toMatchObject([
    { type: 'completion', completion: { turnId: 'c', mergedTurnCount: 3 } }
  ])
  const reused = fixture()
  reused.observe(state('baseline'))
  reused.observe(state('same-id', true))
  reused.observe({
    ...state('same-id'),
    latestRequest: {
      kind: 'turn',
      id: 'same-id',
      turnState: 'running',
      outcome: null,
      settledAt: undefined
    }
  })
  reused.observe(state('same-id'))
  expect(reused.events).toMatchObject([{ completion: { turnId: 'same-id', mergedTurnCount: 2 } }])
})

it('omits the count for a single turn after a coalesced completion and for an unrelated session', () => {
  const f = fixture()
  f.observe(state('baseline'))
  f.observe(state('a', true))
  f.observe(state('b'))
  expect(f.events).toMatchObject([{ completion: { mergedTurnCount: 2 } }])
  f.observe(state('single'))
  f.observe(state('baseline'), { session: 'two' })
  f.observe(state('other'), { session: 'two' })
  expect(f.events.slice(1)).toMatchObject([
    { completion: { turnId: 'single' } },
    { completion: { turnId: 'other' } }
  ])
  for (const event of f.events.slice(1)) {
    if (event.type === 'completion') {
      expect(event.completion).not.toHaveProperty('mergedTurnCount')
    }
  }
})

it.each(['epoch', 'historical', 'closed'] as const)(
  'clears held counts on %s baselining',
  (reset) => {
    const f = fixture()
    f.observe(state('baseline'))
    f.observe(state('a', true))
    f.observe(state('b'))
    expect(f.events).toMatchObject([{ completion: { mergedTurnCount: 2 } }])
    f.events.length = 0
    f.observe(state('c', true))
    const epoch = reset === 'epoch' ? 'new-e' : 'e'
    if (reset === 'closed') {
      f.feed.forget('one')
    }
    f.observe(state('new-baseline'), { epoch, historical: reset === 'historical' })
    f.observe(state('last'), { epoch })
    expect(f.events).toMatchObject([{ completion: { turnId: 'last' } }])
    if (f.events[0]?.type === 'completion') {
      expect(f.events[0].completion).not.toHaveProperty('mergedTurnCount')
    }
  }
)

it('does not count the same held turn twice when owed input is withdrawn', () => {
  const f = fixture()
  f.observe(state('baseline'))
  f.observe(state('a', true))
  f.observe(state('b'))
  expect(f.events).toMatchObject([{ completion: { mergedTurnCount: 2 } }])
  f.events.length = 0
  f.observe(state('c', true))
  f.observe(state('c'))
  expect(f.events).toMatchObject([{ completion: { turnId: 'c' } }])
  if (f.events[0]?.type === 'completion') {
    expect(f.events[0].completion).not.toHaveProperty('mergedTurnCount')
  }
  f.events.length = 0
  f.observe(state('d', true))
  f.observe({
    ...state('refused'),
    latestRequest: {
      kind: 'refused-send',
      id: 'refused',
      turnState: null,
      outcome: 'failure',
      settledAt: 9
    }
  })
  if (f.events[0]?.type === 'completion') {
    expect(f.events[0].completion).not.toHaveProperty('mergedTurnCount')
  }
})

it('drops held counts when the owed work ends without an announced completion', () => {
  const unknown = fixture()
  unknown.observe(state('baseline'))
  unknown.observe(state('a', true))
  unknown.observe({
    ...state('unknown'),
    latestRequest: { ...state('unknown').latestRequest!, outcome: null }
  })
  unknown.observe(state('single'))
  const back = fixture()
  back.observe(state('baseline'))
  back.observe(state('a', true))
  back.observe(state('baseline'))
  back.observe(state('single'))
  for (const f of [unknown, back]) {
    expect(f.events).toMatchObject([{ completion: { turnId: 'single' } }])
    if (f.events[0]?.type === 'completion') {
      expect(f.events[0].completion).not.toHaveProperty('mergedTurnCount')
    }
  }
  // Positive control: the same held turn still merges into the end that follows it.
  const merged = fixture()
  merged.observe(state('baseline'))
  merged.observe(state('a', true))
  merged.observe(state('single'))
  expect(merged.events).toMatchObject([{ completion: { turnId: 'single', mergedTurnCount: 2 } }])
})

it('does not count a held quiet answer as a merged reply', () => {
  const f = fixture()
  f.observe(state('baseline'))
  f.observe({ ...state('quiet', true), quietAnswer: true })
  f.observe({ ...state('quiet', true), quietAnswer: true })
  f.observe(state('b'))
  expect(f.events).toMatchObject([{ completion: { turnId: 'b' } }])
  if (f.events[0]?.type === 'completion') {
    expect(f.events[0].completion).not.toHaveProperty('mergedTurnCount')
  }
  f.events.length = 0
  f.observe({ ...state('quiet-2', true), quietAnswer: true })
  f.observe(state('answer', true))
  f.observe(state('c'))
  expect(f.events).toMatchObject([{ completion: { turnId: 'c', mergedTurnCount: 2 } }])
})
