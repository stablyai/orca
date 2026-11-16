import { expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { structuredQueuePauses } from '../../delivery/structured-agent-session-queued-pause'
import { reportedChildWork } from '../../observations/testing/structured-agent-session-reported-child-work.test-support'
import { setStructuredAgentSessionHost } from '../structured-agent-session-registry'
import {
  createReceivingCallerFixture,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'
import {
  type AccountSwitchFixture,
  accountHome,
  chatOwingBackgroundTask,
  devServer,
  dispatchedTexts,
  MOVED_MESSAGE,
  rows,
  selectB,
  sendWith,
  textOf
} from './structured-agent-session-account-switch.test-support'

const MAIL_FROM = {
  kind: 'agent' as const,
  senders: [
    {
      party: { address: 'agent:coordinator', terminalHandle: null, orcaSessionId: null },
      name: null
    }
  ],
  orchestration: {
    message: 'mail-notice' as const,
    mailbox: 'agent:worker',
    dispatchId: null,
    messages: []
  }
}

const journal = (f: AccountSwitchFixture) =>
  f.rig.host.collaboratorsForTests().sessions.get(PARENT)?.journal

const rejected = (fact: Parameters<typeof agentSessionFailureWords>[0]) => ({
  state: 'rejected' as const,
  ...agentSessionFailureWords(fact, { surface: 'rejection' })
})

it.each([
  {
    outcome: 'refused',
    answer: rejected(agentSessionFailureFact('providerRejected')),
    note: {
      text: "Orca couldn't continue this chat after the account switch. Send a message to continue it.",
      tone: 'error'
    }
  },
  {
    outcome: 'unconfirmed',
    answer: { state: 'unknown' as const, reason: 'lost' },
    note: {
      text: "Orca asked this agent to continue after the account switch but couldn't confirm it did. Check its latest reply before sending another message.",
      tone: 'warning'
    }
  },
  {
    outcome: 'not-connected',
    answer: rejected(
      agentSessionFailureFact('restartFailed', {
        refusal: { code: 'agent_session_ownership_unknown', details: { reason: 'ownerUnproven' } }
      })
    ),
    note: {
      text: "Orca couldn't reconnect this chat after the account switch, so it didn't ask the agent to continue.",
      tone: 'error'
    }
  }
])(
  'a $outcome account-switch continuation is noted as an account switch',
  async ({ answer, note }) => {
    const f = await createReceivingCallerFixture()
    try {
      await chatOwingBackgroundTask(f)
      const accept = f.rig.adapter.dispatch.getMockImplementation()!
      f.rig.adapter.dispatch.mockImplementation(async (input) =>
        textOf(input) === MOVED_MESSAGE ? answer : accept(input)
      )
      void selectB(f, 'restart-all')
      await vi.waitFor(async () =>
        expect((await rows(f)).filter((row) => row.kind === 'status')).toContainEqual({
          kind: 'status',
          ...note
        })
      )
    } finally {
      await f.dispose()
    }
  }
)

const ENDED_LONG_AGO = 1_700_000_000_000

async function completeTurnOpenedBy(f: AccountSwitchFixture, id: string): Promise<void> {
  f.sinks.get(PARENT)!.appendItem(
    { provider: 'claude', sessionId: `provider-${PARENT}`, uuid: `turn-${id}` },
    {
      kind: 'turn',
      turnId: `turn-${id}`,
      state: 'completed',
      userItemId: agentJournalSubmissionKey(id),
      outcome: 'success',
      completedAt: ENDED_LONG_AGO
    },
    { turnScope: { kind: 'thread' } }
  )
  await f.rig.host.flushStreamedEvents(PARENT)
}

it('a send accepted after its own turn ended owes no reply, so the moved chat is not continued', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await f.found()
    f.rig.adapter.dispatch.mockImplementationOnce(async () => ({
      state: 'unknown',
      reason: 'lost'
    }))
    const id = await f.accept('write the report')
    await vi.waitFor(async () =>
      expect((await journal(f)?.reads.submission(id))?.dispatchState).toBe('unknown')
    )
    await f.turn(id, 'running')
    await completeTurnOpenedBy(f, id)
    f.rig.clock.now += 1_000
    await f.rig.host.settleLateDispatch({
      sessionId: PARENT,
      clientMessageId: id,
      providerIdentity: { provider: 'claude', sessionId: `provider-${PARENT}`, uuid: `echo-${id}` }
    })
    expect((await journal(f)?.reads.submission(id))?.dispatchState).toBe('accepted')
    await selectB(f, 'restart-all')
    expect(dispatchedTexts(f)).toEqual(['write the report'])
  } finally {
    await f.dispose()
  }
})

it('a send answered inside the turn opened by the send before it owes no reply once later turns end', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await f.found()
    const first = await f.send('write the report')
    const second = await f.send('and add a summary')
    expect((await journal(f)?.reads.item(agentJournalSubmissionKey(second)))?.turnScope).toEqual({
      kind: 'thread'
    })
    await f.turn(first, 'running')
    await f.turn(first, 'completed')
    const third = await f.send('thanks')
    await f.turn(third, 'running')
    await f.turn(third, 'completed')
    await selectB(f, 'restart-all')
    await f.send('one more')
    expect(f.launches).toEqual([accountHome(f, 'a'), accountHome(f, 'b')])
    expect(dispatchedTexts(f)).toEqual([
      'write the report',
      'and add a summary',
      'thanks',
      'one more'
    ])
  } finally {
    await f.dispose()
  }
})

// Outlasts on the fake clock the three 30 s send waits an account move used to give up after.
it('restart-all moves a chat once a send the agent held past every old wait settles', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await f.found()
    f.rig.adapter.dispatch.mockImplementationOnce(async () => ({ state: 'admitted' }))
    const id = await f.accept('write the report')
    await vi.waitFor(() => expect(f.rig.adapter.dispatch).toHaveBeenCalledTimes(1))
    expect((await journal(f)?.reads.submission(id))?.dispatchState).toBe('pending')
    const warn = vi.spyOn(f.rig.host.deps.logger, 'warn')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const moved = selectB(f, 'restart-all')
    for (let wait = 0; wait < 3; wait += 1) {
      await vi.waitFor(() =>
        expect(f.rig.host['clientDelivery']['sendSettlement']['waiters'].get(PARENT)?.size).toBe(1)
      )
      await vi.advanceTimersByTimeAsync(30_001)
    }
    await f.rig.host.settleLateDispatch({
      sessionId: PARENT,
      clientMessageId: id,
      providerIdentity: { provider: 'claude', sessionId: `provider-${PARENT}`, uuid: `echo-${id}` }
    })
    await moved
    expect(f.launches).toEqual([accountHome(f, 'a'), accountHome(f, 'b')])
    expect(dispatchedTexts(f)).toEqual(['write the report', MOVED_MESSAGE])
    expect(warn.mock.calls.map(([message]) => message)).not.toContain(
      'a chat kept its account while the agent held a send'
    )
  } finally {
    vi.useRealTimers()
    await f.dispose()
  }
})

it('an account-switch continuation leaves a restart-held queued send held', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await f.found()
    const first = await f.send('refactor the parser')
    await f.turn(first, 'running')
    await sendWith(f, 'then add tests', { userSend: true, delivery: 'queue-if-active' })
    await f.rig.restart()
    f.rig.host.deps.adapter.supportsLocation = (location) =>
      location.executionHostId === 'local' && !location.wslDistro
    setStructuredAgentSessionHost(f.rig.host)
    await f.rig.host.history({ sessionId: PARENT, direction: 'tail' })
    expect((await structuredQueuePauses(journal(f)!)).map((pause) => pause.reason)).toEqual([
      'restarted'
    ])
    const mail = await sendWith(f, 'coordinator mail', { from: MAIL_FROM })
    await vi.waitFor(
      async () =>
        expect((await journal(f)?.reads.submission(mail))?.dispatchState).toBe('accepted'),
      {
        timeout: 10_000
      }
    )
    await f.turn(mail, 'running')
    f.rig.host.publishChildWorkEvidence(PARENT, reportedChildWork([devServer], f.rig.clock.now))
    await f.turn(mail, 'completed')
    await selectB(f, 'restart-all')
    expect(dispatchedTexts(f)).toEqual([
      'refactor the parser',
      expect.stringMatching(/^You have 1 orchestration message\./),
      MOVED_MESSAGE
    ])
    expect((await structuredQueuePauses(journal(f)!)).map((pause) => pause.reason)).toEqual([
      'restarted'
    ])
  } finally {
    await f.dispose()
  }
})
