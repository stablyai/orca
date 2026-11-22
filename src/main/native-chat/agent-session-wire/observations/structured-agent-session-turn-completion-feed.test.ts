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

type Behind = [id: string, sequence: number, answered: boolean][]

/** A quiet end with the settled turns the journal holds behind it, newest first. */
const quietEnd = (id: string, behind: Behind, more = false): StructuredAgentSessionStatusState => ({
  ...state(id),
  quietAnswer: true,
  turnsBehind: {
    turns: behind.map(([turnId, sequence, answered]) => ({ id: turnId, sequence, answered })),
    more
  }
})

const merged = (events: AgentSessionTurnCompletionEvent[]) =>
  events.map((event) => (event.type === 'completion' ? event.completion.mergedTurnCount : null))

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

it('merges answered turns behind an end only since the last accounted end', () => {
  const f = fixture()
  f.observe(state('baseline')) // 0
  f.observe(state('a', true)) // 1
  f.observe(state('q', true)) // 2
  f.observe(
    quietEnd('b', [
      ['q', 2, false],
      ['a', 1, true],
      ['baseline', 0, true]
    ])
  ) // 3
  // Behind the last end; `b` itself was rewritten later.
  f.observe(
    quietEnd('c', [
      ['b', 5, true],
      ['a', 1, true]
    ])
  ) // 4
  f.observe(
    quietEnd('d', [
      ['x', 5, true],
      ['c', 4, true]
    ])
  ) // 5
  expect(merged(f.events)).toEqual([2, undefined, 2])
})

it.each(['epoch', 'historical', 'closed'] as const)(
  'never merges turns behind a %s rebaseline',
  (reset) => {
    const f = fixture()
    f.observe(state('baseline')) // 0
    f.observe(state('a', true)) // 1
    const epoch = reset === 'epoch' ? 'new-e' : 'e'
    if (reset === 'closed') {
      f.feed.forget('one')
    }
    f.observe(state('new-baseline'), { epoch, historical: reset === 'historical' }) // 2
    f.observe(
      quietEnd('last', [
        ['new-baseline', 2, true],
        ['a', 1, true]
      ]),
      { epoch }
    ) // 3
    expect(merged(f.events)).toEqual([undefined])
  }
)

it('still merges when more settled turns sit behind a full window', () => {
  const f = fixture()
  f.observe(state('baseline')) // 0
  f.observe(state('held', true)) // 1
  f.observe(
    quietEnd(
      'last',
      [
        ['q2', 3, false],
        ['q1', 2, false]
      ],
      true
    )
  ) // 2
  expect(merged(f.events)).toEqual([3])
})
