import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalTurnLifecycle } from '../../../shared/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
} as const

function turn(
  turnId: string,
  state: AgentJournalTurnLifecycle['state'],
  outcome?: AgentJournalTurnLifecycle['outcome']
): AgentJournalTurnLifecycle {
  return { turnId, state, ...(outcome ? { outcome } : {}) }
}

function harness(): {
  feed: StructuredAgentSessionTurnCompletionFeed
  setTurn: (next: AgentJournalTurnLifecycle | null) => void
  setCursor: (next: { epoch: string; sequence: number }) => void
  observe: () => void
  events: AgentSessionTurnCompletionEvent[]
  listen: () => () => void
} {
  let current: AgentJournalTurnLifecycle | null = null
  let cursor = { epoch: 'epoch-1', sequence: 0 }
  const journal = {
    newestTurn: () => current,
    cursor: () => cursor
  }
  const sessions = new Map([['session-1', { journal, params: { location: LOCATION } }]])
  const feed = new StructuredAgentSessionTurnCompletionFeed({ sessions, now: () => 1_700 })
  const events: AgentSessionTurnCompletionEvent[] = []
  return {
    feed,
    setTurn: (next) => {
      current = next
    },
    setCursor: (next) => {
      cursor = next
    },
    observe: () => feed.observe('session-1'),
    events,
    listen: () => feed.subscribe({ id: 'sub', emit: (event) => events.push(event) })
  }
}

describe('StructuredAgentSessionTurnCompletionFeed', () => {
  it('emits a completion when a turn settles with a success outcome', () => {
    const h = harness()
    h.listen()
    h.setTurn(turn('turn-1', 'running'))
    h.setCursor({ epoch: 'epoch-1', sequence: 1 })
    h.observe()
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-1', sequence: 2 })
    h.observe()
    expect(h.events).toEqual([
      {
        type: 'completion',
        completion: {
          scope: LOCATION,
          sessionId: 'session-1',
          turnId: 'turn-1',
          outcome: 'success',
          completedAt: 1_700
        }
      }
    ])
  })

  it('carries failure and cancellation verbatim rather than filtering them here', () => {
    // The host reports what happened; deciding what lights up is the client's policy.
    for (const outcome of ['failure', 'cancellation'] as const) {
      const h = harness()
      h.listen()
      h.setTurn(turn('turn-1', 'running'))
      h.setCursor({ epoch: 'epoch-1', sequence: 1 })
      h.observe()
      h.setTurn(turn('turn-1', 'completed', outcome))
      h.setCursor({ epoch: 'epoch-1', sequence: 2 })
      h.observe()
      expect(h.events).toHaveLength(1)
      expect(h.events[0]).toMatchObject({ completion: { outcome } })
    }
  })

  it.each(['completed', 'interrupted', 'unverifiable'] as const)(
    'emits nothing for a %s turn with no outcome, because absent means unknown',
    (state) => {
      // `completed` is the one that matters: a provider reports its own API error as a finished
      // turn, so reading "settled" as "succeeded" would light the dot on a failure.
      const h = harness()
      h.listen()
      h.setTurn(turn('turn-1', 'running'))
      h.setCursor({ epoch: 'epoch-1', sequence: 1 })
      h.observe()
      h.setTurn(turn('turn-1', state))
      h.setCursor({ epoch: 'epoch-1', sequence: 2 })
      h.observe()
      expect(h.events).toEqual([])
    }
  )

  it('emits nothing on the first observation, so restore and restart stay silent', () => {
    const h = harness()
    h.listen()
    // A session re-attached with history already settled: this is not news.
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.observe()
    h.observe()
    expect(h.events).toEqual([])
  })

  it('emits once per turn even when the settled record is republished', () => {
    const h = harness()
    h.listen()
    h.setTurn(turn('turn-1', 'running'))
    h.setCursor({ epoch: 'epoch-1', sequence: 1 })
    h.observe()
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-1', sequence: 2 })
    h.observe()
    h.observe()
    h.observe()
    expect(h.events).toHaveLength(1)
  })

  it('emits again for the next turn', () => {
    const h = harness()
    h.listen()
    h.setTurn(turn('turn-1', 'running'))
    h.setCursor({ epoch: 'epoch-1', sequence: 1 })
    h.observe()
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-1', sequence: 2 })
    h.observe()
    h.setTurn(turn('turn-2', 'running'))
    h.setCursor({ epoch: 'epoch-1', sequence: 3 })
    h.observe()
    h.setTurn(turn('turn-2', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-1', sequence: 4 })
    h.observe()
    expect(h.events.map((event) => event.type === 'completion' && event.completion.turnId)).toEqual(
      ['turn-1', 'turn-2']
    )
  })

  it('re-baselines after forget, so a re-attached session does not re-announce', () => {
    const h = harness()
    h.listen()
    h.setTurn(turn('turn-1', 'running'))
    h.setCursor({ epoch: 'epoch-1', sequence: 1 })
    h.observe()
    h.feed.forget('session-1')
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-1', sequence: 2 })
    h.observe()
    expect(h.events).toEqual([])
  })

  // LIVE-ONLY PIN. If a later refactor adds a retained snapshot or a replay arm to make a
  // reconnecting client "catch up", these two tests are what fails.
  it('replays nothing to a subscriber that arrives after the completion', () => {
    const h = harness()
    h.setTurn(turn('turn-1', 'running'))
    h.setCursor({ epoch: 'epoch-1', sequence: 1 })
    h.observe()
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-1', sequence: 2 })
    h.observe()
    h.listen()
    expect(h.events).toEqual([])
  })

  it('drops a completion that lands while nobody is subscribed', () => {
    const h = harness()
    const stop = h.listen()
    h.setTurn(turn('turn-1', 'running'))
    h.setCursor({ epoch: 'epoch-1', sequence: 1 })
    h.observe()
    stop()
    h.events.length = 0
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-1', sequence: 2 })
    h.observe()
    h.listen()
    // The host advanced its own mark with no subscriber to tell; nothing is queued for the next.
    h.observe()
    expect(h.events).toEqual([])
  })

  it('emits end on unsubscribe and stops delivering', () => {
    const h = harness()
    const stop = h.listen()
    stop()
    expect(h.events).toEqual([{ type: 'end' }])
    h.setTurn(turn('turn-1', 'running'))
    h.setCursor({ epoch: 'epoch-1', sequence: 1 })
    h.observe()
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-1', sequence: 2 })
    h.observe()
    expect(h.events).toEqual([{ type: 'end' }])
  })

  it('drops a subscriber whose transport throws without losing the others', () => {
    const h = harness()
    const good: AgentSessionTurnCompletionEvent[] = []
    h.feed.subscribe({
      id: 'bad',
      emit: () => {
        throw new Error('transport gone')
      }
    })
    h.feed.subscribe({ id: 'good', emit: (event) => good.push(event) })
    h.setTurn(turn('turn-1', 'running'))
    h.observe()
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.observe()
    expect(good).toHaveLength(1)
  })

  it('re-baselines an epoch replacement without announcing retained history', () => {
    const h = harness()
    h.listen()
    h.setTurn(turn('turn-1', 'running'))
    h.setCursor({ epoch: 'epoch-1', sequence: 1 })
    h.observe()
    h.setTurn(turn('turn-1', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-1', sequence: 2 })
    h.observe()
    h.events.length = 0

    // A rewind republishes an earlier settled turn in a new journal epoch.
    h.setTurn(turn('turn-old', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-2', sequence: 2 })
    h.observe()
    expect(h.events).toEqual([])

    h.setTurn(turn('turn-new', 'running'))
    h.setCursor({ epoch: 'epoch-2', sequence: 3 })
    h.observe()
    h.setTurn(turn('turn-new', 'completed', 'success'))
    h.setCursor({ epoch: 'epoch-2', sequence: 4 })
    h.observe()
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ completion: { turnId: 'turn-new' } })
  })

  it('ignores a session the host is not holding', () => {
    const h = harness()
    h.listen()
    const emit = vi.fn()
    h.feed.subscribe({ id: 'other', emit })
    h.feed.observe('session-unknown')
    expect(emit).not.toHaveBeenCalled()
  })
})
