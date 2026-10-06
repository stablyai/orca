import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED,
  DISPATCH_REJECTED_NOT_DELIVERED,
  DISPATCH_REJECTED_PROVIDER_CLOSED
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import {
  LOCATION,
  START_FAILURE,
  harness,
  pending,
  refused,
  sent,
  turn,
  turnItem,
  userEntry
} from './structured-agent-session-turn-completion-feed-test-harness'

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
    // Strict: an idle settle omits `awaitingUser` rather than sending it undefined.
    expect(h.events).toStrictEqual([
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
    DISPATCH_REJECTED_PROVIDER_CLOSED,
    DISPATCH_REJECTED_NOT_DELIVERED
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

  it('never notifies a crash-stranded send that restart reconciliation finds undelivered', () => {
    const h = afterSuccessfulTurn()
    const items = [userEntry('m1', 1), settledTurn, userEntry('m2', 3)]
    const accepted = sent('m1', { dispatchState: 'accepted' })
    h.setJournal(items, [accepted, sent('m2', { dispatchState: 'unknown', recovered: true })], 2)
    h.observe()
    h.setJournal(
      items,
      [
        accepted,
        sent('m2', {
          dispatchState: 'rejected',
          reason: DISPATCH_REJECTED_NOT_DELIVERED,
          fence: 2,
          recovered: true
        })
      ],
      2
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

  const failedStart = (clientMessageId: string) =>
    sent(clientMessageId, {
      dispatchState: 'rejected',
      reason: "Codex couldn't start.",
      rejection: { kind: 'startFailed' }
    })

  it('notifies a failed start once, the moment it is final, though a later send is still owed', () => {
    const h = harness()
    h.listen()
    h.observe()
    const queued = [userEntry('m1', 1), userEntry('m2', 2)]
    h.setJournal(queued, [pending('m1'), pending('m2')])
    h.observe()
    h.setJournal(queued, [failedStart('m1'), pending('m2')])
    h.observe()
    const accepted = sent('m2', { dispatchState: 'accepted' })
    h.setJournal([...queued, turnItem(turn('t2', 'running'), 3)], [failedStart('m1'), accepted])
    h.observe()
    h.setJournal(
      [...queued, turnItem(turn('t2', 'completed', 'success'), 3)],
      [failedStart('m1'), accepted]
    )
    h.observe()
    h.observe()
    expect(h.outcomes()).toEqual([
      [M1, 'failure'],
      ['t2', 'success']
    ])
  })

  it('notifies a lone failed start exactly once', () => {
    const h = harness()
    h.listen()
    h.observe()
    h.setJournal([userEntry('m1', 1)], [pending('m1')])
    h.observe()
    h.setJournal([userEntry('m1', 1)], [failedStart('m1')])
    h.observe()
    h.observe()
    expect(h.outcomes()).toEqual([[M1, 'failure']])
  })

  // The person ended the wait, so its end is not news; the message still reads as failed.
  it.each([
    ['the chat closed', 'chatClosed'],
    ['Orca restarted', 'hostRestarted']
  ] as const)(
    'notifies nothing for a send whose wait for its next start ended because %s',
    (_end, rejectionCause) => {
      const h = afterSuccessfulTurn()
      const items = [userEntry('m1', 1), settledTurn, userEntry('m2', 3)]
      const accepted = sent('m1', { dispatchState: 'accepted' })
      const waitFailure = { kind: 'accountSwitchInProgress' as const }
      const waiting = sent('m2', {
        dispatchState: 'pending',
        resolvedAt: null,
        startRetry: {
          attempts: 1,
          reason: 'A Claude account switch is in progress.',
          rejection: waitFailure,
          failedAt: 30,
          nextAttemptAt: 15_030
        }
      })
      const ended = sent('m2', {
        dispatchState: 'rejected',
        reason: 'A Claude account switch is in progress. Try again after it finishes.',
        rejection: waitFailure,
        rejectionCause,
        resolvedAt: 40
      })
      h.setJournal(items, [accepted, waiting])
      h.observe()
      h.setJournal(items, [accepted, ended])
      h.observe()
      h.observe()

      expect(h.outcomes()).toEqual([['t1', 'success']])
      expect(
        projectStructuredAgentSessionStatusState(items, [accepted, ended]).latestRequest
      ).toMatchObject({ kind: 'refused-send', id: M2, outcome: 'failure' })
    }
  )

  // A conversation command is not a request: the session's verdict passes it over, and so does this.
  it('notifies nothing for a /compact whose start failed for good', () => {
    const h = afterSuccessfulTurn()
    const compact: AgentJournalRenderItem = {
      ...userEntry('m2', 3),
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }
    }
    const items = [userEntry('m1', 1), settledTurn, compact]
    const accepted = sent('m1', { dispatchState: 'accepted' })
    h.setJournal(items, [accepted, pending('m2')])
    h.observe()
    h.setJournal(items, [accepted, failedStart('m2')])
    h.observe()
    h.observe()

    expect(h.outcomes()).toEqual([['t1', 'success']])
  })

  // Its failure is not final while it waits, and a Stop that withdraws it brings back a request
  // already announced.
  it('notifies nothing for a send waiting for its next start, nor when a Stop withdraws it', () => {
    const h = afterSuccessfulTurn()
    const items = [userEntry('m1', 1), settledTurn, userEntry('m2', 3)]
    const accepted = sent('m1', { dispatchState: 'accepted' })
    const waiting = sent('m2', {
      dispatchState: 'pending',
      resolvedAt: null,
      startRetry: {
        attempts: 1,
        reason: 'A Claude account switch is in progress.',
        rejection: { kind: 'accountSwitchInProgress' },
        failedAt: 30,
        nextAttemptAt: 15_030
      }
    })
    h.setJournal(items, [accepted, waiting])
    h.observe()
    h.setJournal(items, [accepted, refused('m2', DISPATCH_REJECTED_CANCELLED)])
    h.observe()
    expect(h.outcomes()).toEqual([['t1', 'success']])
  })

  // A waiting send lets later ones go first, so its final failure can come after their turn ends.
  it.each([
    [
      'after the later turn succeeded',
      50,
      [
        ['t2', 'success'],
        [M1, 'failure']
      ]
    ],
    [
      'before the later turn succeeded',
      25,
      [
        [M1, 'failure'],
        ['t2', 'success']
      ]
    ]
  ] as const)(
    'notifies the final failure of a send that waited, once, when it comes %s',
    (_order, finalFailureAt, expected) => {
      const h = harness()
      h.listen()
      h.observe()
      const waiting = sent('m1', {
        dispatchState: 'pending',
        resolvedAt: null,
        startRetry: {
          attempts: 1,
          reason: START_FAILURE,
          rejection: { kind: 'accountSwitchInProgress' },
          failedAt: 15,
          nextAttemptAt: 30
        }
      })
      const failed = sent('m1', {
        dispatchState: 'rejected',
        reason: START_FAILURE,
        rejection: { kind: 'accountSwitchInProgress' },
        resolvedAt: finalFailureAt
      })
      const accepted = sent('m2', { dispatchState: 'accepted' })
      const items = (state: 'running' | 'completed') => [
        userEntry('m1', 1),
        userEntry('m2', 2),
        turnItem(
          {
            turnId: 't2',
            state,
            ...(state === 'completed' ? { outcome: 'success', completedAt: 40 } : {})
          },
          3
        )
      ]
      h.setJournal([userEntry('m1', 1), userEntry('m2', 2)], [waiting, pending('m2')])
      h.observe()
      h.setJournal(items('running'), [waiting, accepted])
      h.observe()
      if (finalFailureAt < 40) {
        h.setJournal(items('running'), [failed, accepted])
        h.observe()
      }
      h.setJournal(items('completed'), [finalFailureAt < 40 ? failed : waiting, accepted])
      h.observe()
      h.setJournal(items('completed'), [failed, accepted])
      h.observe()
      h.observe()
      expect(h.outcomes()).toEqual(expected)
    }
  )

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

describe('a request that settles while the user is asked something', () => {
  const M1 = agentJournalSubmissionKey('m1')

  /** An approval the user has not answered; `agentId` makes it a subagent's. */
  function approval(
    itemId: string,
    sequence: number,
    state: 'pending' | 'resolved',
    agentId?: string
  ): AgentJournalRenderItem {
    return {
      itemId,
      revision: state === 'pending' ? 1 : 2,
      sequence,
      observedAt: sequence,
      ...(agentId ? { agentId } : {}),
      body: {
        kind: 'approval',
        title: 'Run command?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state, selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    }
  }

  it('notifies once when the main turn settles while a subagent waits on an approval', () => {
    const h = harness()
    h.listen()
    const user = userEntry('m1', 1)
    const accepted = [sent('m1', { dispatchState: 'accepted' })]
    h.setJournal([user, turnItem(turn('t1', 'running'), 2)], accepted)
    h.observe()
    h.setJournal(
      [user, turnItem(turn('t1', 'running'), 2), approval('a1', 3, 'pending', 'child-1')],
      accepted
    )
    h.observe()
    h.setJournal(
      [
        user,
        turnItem(turn('t1', 'completed', 'success'), 2),
        approval('a1', 3, 'pending', 'child-1')
      ],
      accepted
    )
    h.observe()
    expect(h.outcomes()).toEqual([['t1', 'success']])
    expect(h.awaitingUser()).toEqual([true])

    // Answering the prompt settles the session idle on the request already announced.
    h.setJournal(
      [
        user,
        turnItem(turn('t1', 'completed', 'success'), 2),
        approval('a1', 3, 'resolved', 'child-1')
      ],
      accepted
    )
    h.observe()
    expect(h.outcomes()).toEqual([['t1', 'success']])
  })

  it('notifies a refused send once while a prompt is pending', () => {
    const h = harness()
    h.listen()
    const prompt = approval('a1', 1, 'pending', 'child-1')
    h.setJournal([prompt, userEntry('m1', 2)], [pending('m1')])
    h.observe()
    h.setJournal([prompt, userEntry('m1', 2)], [refused('m1')])
    h.observe()
    expect(h.outcomes()).toEqual([[M1, 'failure']])
    expect(h.awaitingUser()).toEqual([true])
    h.setJournal([approval('a1', 1, 'resolved', 'child-1'), userEntry('m1', 2)], [refused('m1')])
    h.observe()
    expect(h.outcomes()).toEqual([[M1, 'failure']])
  })

  it('sends nothing while the main turn asks for permission, and one event when it settles', () => {
    const h = harness()
    h.listen()
    const user = userEntry('m1', 1)
    const accepted = [sent('m1', { dispatchState: 'accepted' })]
    h.setJournal([user, turnItem(turn('t1', 'running'), 2)], accepted)
    h.observe()
    h.setJournal([user, turnItem(turn('t1', 'running'), 2), approval('a1', 3, 'pending')], accepted)
    h.observe()
    expect(h.events).toEqual([])
    h.setJournal(
      [user, turnItem(turn('t1', 'running'), 2), approval('a1', 3, 'resolved')],
      accepted
    )
    h.observe()
    h.setJournal(
      [user, turnItem(turn('t1', 'completed', 'success'), 2), approval('a1', 3, 'resolved')],
      accepted
    )
    h.observe()
    expect(h.outcomes()).toEqual([['t1', 'success']])
    // Idle when it settles: the prompt was already answered.
    expect(h.awaitingUser()).toEqual([false])
  })

  it('still waits on a queued send the prompt hides, so the queue notifies once', () => {
    const h = harness()
    h.listen()
    const prompt = approval('a1', 3, 'pending', 'child-1')
    const items = [userEntry('m1', 1), turnItem(turn('t1', 'running'), 2), prompt]
    const queued = sent('m2', { dispatchState: 'pending', resolvedAt: null })
    const accepted = sent('m1', { dispatchState: 'accepted' })
    h.setJournal([...items, userEntry('m2', 4)], [accepted, queued])
    h.observe()
    h.setJournal(
      [
        userEntry('m1', 1),
        turnItem(turn('t1', 'completed', 'success'), 2),
        prompt,
        userEntry('m2', 4)
      ],
      [accepted, queued]
    )
    h.observe()
    expect(h.events).toEqual([])
  })
})
