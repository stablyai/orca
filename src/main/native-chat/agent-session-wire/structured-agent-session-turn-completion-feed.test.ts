import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED,
  DISPATCH_REJECTED_PROVIDER_CLOSED
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
} as const

const START_FAILURE = 'Claude is not signed in.'

function turn(
  turnId: string,
  state: AgentJournalTurnLifecycle['state'],
  outcome?: AgentJournalTurnLifecycle['outcome']
): AgentJournalTurnLifecycle {
  return { turnId, state, ...(outcome ? { outcome } : {}) }
}

function turnItem(lifecycle: AgentJournalTurnLifecycle, sequence: number): AgentJournalRenderItem {
  return {
    itemId: `codex:turn:${lifecycle.turnId}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', ...lifecycle }
  }
}

function userEntry(clientMessageId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(clientMessageId),
    revision: 0,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] }
  }
}

function sent(
  clientMessageId: string,
  fields: Partial<AgentJournalSubmission> & Pick<AgentJournalSubmission, 'dispatchState'>
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: 20,
    handoverRecorded: true,
    ...fields
  }
}

const pending = (clientMessageId: string, fence = 1) =>
  sent(clientMessageId, { dispatchState: 'pending', fence, handedOverAt: 11, resolvedAt: null })
const refused = (clientMessageId: string, reason = START_FAILURE) =>
  sent(clientMessageId, { dispatchState: 'rejected', reason })

function harness(): {
  feed: StructuredAgentSessionTurnCompletionFeed
  setTurn: (next: AgentJournalTurnLifecycle | null) => void
  setJournal: (
    items: AgentJournalRenderItem[],
    submissions: AgentJournalSubmission[],
    fence?: number
  ) => void
  setCursor: (next: { epoch: string; sequence: number }) => void
  observe: () => void
  events: AgentSessionTurnCompletionEvent[]
  outcomes: () => [string, string][]
  listen: () => () => void
} {
  let items: AgentJournalRenderItem[] = []
  let submissions: AgentJournalSubmission[] = []
  let fence: number | undefined
  let cursor = { epoch: 'epoch-1', sequence: 0 }
  const journal = { cursor: () => cursor }
  const sessions = new Map([['session-1', { journal, params: { location: LOCATION } }]])
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    sessions,
    now: () => 1_700,
    // The status feed's projection, computed as it computes it.
    readStatusState: () => projectStructuredAgentSessionStatusState(items, submissions, fence)
  })
  const events: AgentSessionTurnCompletionEvent[] = []
  return {
    feed,
    setTurn: (next) => {
      items = next ? [turnItem(next, 1)] : []
      submissions = []
    },
    setJournal: (nextItems, nextSubmissions, nextFence) => {
      items = nextItems
      submissions = nextSubmissions
      fence = nextFence
      cursor = { ...cursor, sequence: cursor.sequence + 1 }
    },
    setCursor: (next) => {
      cursor = next
    },
    observe: () => feed.observe('session-1'),
    events,
    outcomes: () =>
      events.flatMap((event): [string, string][] =>
        event.type === 'completion' ? [[event.completion.turnId, event.completion.outcome]] : []
      ),
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

  it('announces no /compact turn and keeps its mark on the last real turn (B6)', () => {
    const h = harness()
    h.listen()
    const real = [userEntry('m1', 1), turnItem(turn('t1', 'completed', 'success'), 2)]
    const accepted = sent('m1', { dispatchState: 'accepted' })
    h.setJournal(real, [accepted])
    h.observe()
    const command: AgentJournalRenderItem = {
      ...userEntry('c1', 3),
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }
    }
    const commandTurn = (lifecycle: AgentJournalTurnLifecycle): AgentJournalRenderItem => ({
      ...turnItem({ ...lifecycle, userItemId: command.itemId }, 4),
      itemId: 'orca:command-turn:c1'
    })
    h.setJournal(
      [...real, command, commandTurn(turn('compact:c1', 'running'))],
      [accepted, pending('c1')]
    )
    h.observe()
    h.setJournal(
      [...real, command, commandTurn(turn('compact:c1', 'completed', 'success'))],
      [accepted, sent('c1', { dispatchState: 'accepted' })]
    )
    h.observe()
    expect(h.events).toEqual([])
  })
})

describe('a request the agent or its start refused', () => {
  const M1 = agentJournalSubmissionKey('m1')
  const M2 = agentJournalSubmissionKey('m2')
  const M3 = agentJournalSubmissionKey('m3')
  const settledTurn = turnItem(turn('t1', 'completed', 'success'), 2)

  /** A session whose first turn succeeded, as the feed saw it happen. */
  function afterSuccessfulTurn() {
    const h = harness()
    h.listen()
    h.setJournal([userEntry('m1', 1), turnItem(turn('t1', 'running'), 2)], [])
    h.observe()
    h.setJournal([userEntry('m1', 1), settledTurn], [sent('m1', { dispatchState: 'accepted' })])
    h.observe()
    expect(h.outcomes()).toEqual([['t1', 'success']])
    return h
  }

  it('notifies failed once when the only send fails to start, named by its item key', () => {
    const h = harness()
    h.listen()
    h.observe()
    h.setJournal([userEntry('m1', 1)], [pending('m1')])
    h.observe()
    h.setJournal([userEntry('m1', 1)], [refused('m1')])
    h.observe()
    h.observe()
    expect(h.events).toEqual([
      {
        type: 'completion',
        completion: {
          scope: LOCATION,
          sessionId: 'session-1',
          turnId: M1,
          outcome: 'failure',
          completedAt: 1_700
        }
      }
    ])
  })

  it('stays silent on a first observation of a send that had already failed', () => {
    // A restart, reopen or re-attach: the failure is history, not news.
    const h = harness()
    h.listen()
    h.setJournal([userEntry('m1', 1)], [refused('m1')])
    h.observe()
    h.observe()
    expect(h.events).toEqual([])
  })

  it('re-baselines an epoch replacement that surfaces an older failure', () => {
    const h = afterSuccessfulTurn()
    h.setJournal([userEntry('m1', 1)], [refused('m1')])
    h.setCursor({ epoch: 'epoch-2', sequence: 1 })
    h.observe()
    expect(h.outcomes()).toEqual([['t1', 'success']])
  })

  it.each([
    DISPATCH_REJECTED_CANCELLED,
    DISPATCH_REJECTED_HOST_RESTARTED,
    DISPATCH_REJECTED_PROVIDER_CLOSED
  ])('never notifies a send %s, alone or after a turn', (reason) => {
    const alone = harness()
    alone.listen()
    alone.observe()
    alone.setJournal([userEntry('m1', 1)], [pending('m1')])
    alone.observe()
    alone.setJournal([userEntry('m1', 1)], [refused('m1', reason)])
    alone.observe()
    expect(alone.events).toEqual([])

    // The latest request falls back to the turn already announced, which must not announce again.
    const h = afterSuccessfulTurn()
    const accepted = sent('m1', { dispatchState: 'accepted' })
    h.setJournal([userEntry('m1', 1), settledTurn, userEntry('m2', 3)], [accepted, pending('m2')])
    h.observe()
    h.setJournal(
      [userEntry('m1', 1), settledTurn, userEntry('m2', 3)],
      [accepted, refused('m2', reason)]
    )
    h.observe()
    expect(h.outcomes()).toEqual([['t1', 'success']])
  })

  it('notifies failed, then success, when a failed start is retried and the retry succeeds', () => {
    const h = harness()
    h.listen()
    h.observe()
    h.setJournal([userEntry('m1', 1)], [refused('m1')])
    h.observe()
    h.setJournal([userEntry('m1', 1), userEntry('m2', 2)], [refused('m1'), pending('m2')])
    h.observe()
    const accepted = sent('m2', { dispatchState: 'accepted' })
    h.setJournal(
      [userEntry('m1', 1), userEntry('m2', 2), turnItem(turn('t2', 'running'), 3)],
      [refused('m1'), accepted]
    )
    h.observe()
    h.setJournal(
      [userEntry('m1', 1), userEntry('m2', 2), turnItem(turn('t2', 'completed', 'success'), 3)],
      [refused('m1'), accepted]
    )
    h.observe()
    expect(h.outcomes()).toEqual([
      [M1, 'failure'],
      ['t2', 'success']
    ])
  })

  it('notifies each failed start that follows another', () => {
    const h = harness()
    h.listen()
    h.observe()
    h.setJournal([userEntry('m1', 1)], [refused('m1')])
    h.observe()
    h.setJournal([userEntry('m1', 1), userEntry('m2', 2)], [refused('m1'), pending('m2')])
    h.observe()
    h.setJournal([userEntry('m1', 1), userEntry('m2', 2)], [refused('m1'), refused('m2')])
    h.observe()
    expect(h.outcomes()).toEqual([
      [M1, 'failure'],
      [M2, 'failure']
    ])
  })

  it.each([
    ['in one commit', [['m2', 'm3']]],
    ['oldest first, across commits', [['m2'], ['m3']]],
    ['newest first, across commits', [['m3'], ['m2']]]
  ])('notifies once for queued sends one start failure refused %s', (_name, batches) => {
    const h = afterSuccessfulTurn()
    const items = [userEntry('m1', 1), settledTurn, userEntry('m2', 3), userEntry('m3', 4)]
    const accepted = sent('m1', { dispatchState: 'accepted' })
    const queued = (id: string) => sent(id, { dispatchState: 'pending', resolvedAt: null })
    const answered = new Set<string>()
    const submissions = () => [
      accepted,
      ...['m2', 'm3'].map((id) => (answered.has(id) ? refused(id) : queued(id)))
    ]
    h.setJournal(items, submissions())
    h.observe()
    for (const batch of batches) {
      batch.forEach((id) => answered.add(id))
      h.setJournal(items, submissions())
      h.observe()
    }
    expect(h.outcomes()).toEqual([
      ['t1', 'success'],
      [M3, 'failure']
    ])
  })

  it('does not wait on a send left pending at an older fence', () => {
    const h = harness()
    h.listen()
    h.setJournal([userEntry('m1', 1), userEntry('m2', 2)], [pending('m1', 1), pending('m2', 2)], 2)
    h.observe()
    h.setJournal([userEntry('m1', 1), userEntry('m2', 2)], [pending('m1', 1), refused('m2')], 2)
    h.observe()
    expect(h.outcomes()).toEqual([[M2, 'failure']])
  })
})
