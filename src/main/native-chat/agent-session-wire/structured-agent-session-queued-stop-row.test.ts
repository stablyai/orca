import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalAnsweredTurnIdentity } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { HOST_TEST_SESSION, HOST_TEST_THREAD } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  vi.useFakeTimers()
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(async () => {
  try {
    await rig.dispose()
  } finally {
    vi.useRealTimers()
  }
})

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

function journal(sessionId = HOST_TEST_SESSION) {
  const open = rig.host.collaboratorsForTests().sessions.get(sessionId)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

async function expectHeld(reason: string | null, ...draftIds: string[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(250)
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
  expect(await rig.queuePause()).toEqual(reason === null ? null : { reason })
}

function withdraw(clientMessageId: string, answeredInTurn?: AgentJournalAnsweredTurnIdentity) {
  return rig.host.settleLateDispatch({
    sessionId: HOST_TEST_SESSION,
    clientMessageId,
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
    ...(answeredInTurn ? { answeredInTurn } : {})
  })
}

async function send(clientMessageId: string) {
  return (await rig.host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

async function drawn(clientMessageId: string) {
  const { items, submissions } = await rig.host.journalSnapshot(HOST_TEST_SESSION)
  const message = projectStructuredAgentSessionMessages(items, [], submissions).find(
    (entry) => entry.id === agentJournalSubmissionKey(clientMessageId)
  )
  return message ? { stoppedBeforeStart: message.stoppedBeforeStart } : null
}

it('a card handed over and stopped before the agent confirms it reads as sent, never sent again; only the cards behind it send', async () => {
  const working = await rig.workingSend()
  await openRigTurnFor(rig, working)
  const steered = await queuedDraft('sent now into the turn')
  const opening = await queuedDraft('opens its own turn')
  const last = await queuedDraft('waiting behind them')
  await rig.sendNow(steered)
  await eventually(async () => expect((await rig.handoff(steered))?.handedOverAt).toBeDefined())
  const steer = await rig.handoffId(steered)

  await rig.stop()
  await withdraw(steer, {
    turn: {
      provider: 'codex',
      threadId: HOST_TEST_THREAD,
      turnId: `turn-of-${working}`,
      ordinal: 0
    },
    via: 'steer'
  })
  await rig.settleAccepted(working, 'stopped')
  await openRigTurnFor(rig, working, 'interrupted')
  await expectHeld('stopped', opening, last)
  expect(await rig.drafts()).toEqual([
    { messageId: opening, state: 'waiting' },
    { messageId: last, state: 'waiting' }
  ])

  expect(await send(steer)).toMatchObject({ dispatchState: 'unknown', recovered: true })
  expect(await drawn(steer)).toEqual({ stoppedBeforeStart: undefined })

  expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
  await eventually(async () => expect((await rig.handoff(opening))?.handedOverAt).toBeDefined())
  const opener = await rig.handoffId(opening)
  await rig.stop()
  await withdraw(opener)
  await expectHeld('stopped', last)
  expect(await rig.drafts()).toEqual([{ messageId: last, state: 'waiting' }])

  expect(await send(opener)).toMatchObject({ dispatchState: 'rejected' })
  expect(await drawn(opener)).toEqual({ stoppedBeforeStart: true })

  expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
  await eventually(async () => expect(await rig.handoff(last)).toBeDefined())
  await rig.settleAccepted(await rig.handoffId(last), 'last')
  expect([await rig.handoffId(steered), (await send(opener))?.dispatchState]).toEqual([
    steer,
    'rejected'
  ])

  await rig.restartHostProcess()
  await rig.queuePause()
  expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).not.toContain('restarted')
})
