import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'

import { createJournalReducerState } from './projection/journal-reducer'

import { journalInputOrder } from './input-order/journal-input-order'
import { journalDispatchRowBuilder } from './writing/journal-row-builders'
import { readJournalStatusIndicators } from './journal-status-indicators'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'

function fixture() {
  return createJournalReducerState('session', 'epoch')
}
function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: 1, body }
}
const user = { kind: 'message' as const, role: 'user' as const, blocks: [] }

it('uses input ordinals, native membership and visible steer seeds for indicators', () => {
  const state = fixture()
  const order = journalInputOrder(state)
  const send = (id: string, submittedAt: number, extra: Partial<AgentJournalSubmission> = {}) => {
    state.submissions.set(id, {
      clientMessageId: id,
      fence: 0,
      payloadFingerprint: id,
      dispatchState: 'accepted',
      providerItemId: null,
      reason: null,
      submittedAt,
      resolvedAt: null,
      acceptedSequence: 1,
      ...extra
    })
    order.afterRow(
      state,
      journalDispatchRowBuilder(() => state, {
        clientMessageId: id,
        state: 'accepted',
        providerIdentity: null,
        fence: 0
      })(1, submittedAt)
    )
  }
  send('provider-only', 1, { providerItemId: 'provider' })
  state.items.set('provider', item('provider', 1, user))
  send('native', 20)
  state.items.set('orca:native', item('orca:native', 2, user))
  send('latest', 20)
  state.items.set('orca:latest', item('orca:latest', 3, { kind: 'status', text: 'Command' }))
  const read = (start = 0, floor = 0) => readJournalStatusIndicators(state, { start, floor })
  expect(read()).toEqual({
    acceptedSendKey: 'epoch:latest',
    firstInputSubmissionKey: '["epoch","native"]',
    submissionCount: 3,
    stopping: false
  })
  expect(read(2).firstInputSubmissionKey).toBeNull()
  expect(read(0, 2).firstInputSubmissionKey).toBeNull()
  state.items.delete('orca:native')
  expect(read().firstInputSubmissionKey).toBeNull()
  state.items.set('old-target', item('old-target', 4, { kind: 'status', text: 'Old target' }))
  send('provider-only', 1, {
    providerItemId: 'provider',
    answeredInTurn: { turnItemId: 'old-target', via: 'steer' }
  })
  expect(read().firstInputSubmissionKey).toBe('["epoch","provider-only"]')
  state.items.delete('old-target')
  expect(read().firstInputSubmissionKey).toBeNull()
  send('latest', 0)
  expect(read().acceptedSendKey).toBe('epoch:native')
  expect(structuredClone(read())).toEqual(read())
})

it('binds failed Stop to the first visible opening before the next send', () => {
  const state = fixture()
  const stop: JournalLatestStop = {
    sequence: 10,
    event: { reason: 'user-stop', at: 1 },
    settle: { settling: false, failedOn: { openedAfter: 10 } }
  }
  const turn = (id: string, at: number, running: boolean) =>
    item(id, at, {
      kind: 'turn',
      turnId: id,
      state: running ? 'running' : 'completed'
    })
  state.items.set('finished', turn('finished', 11, false))
  state.items.set('live', turn('live', 12, true))
  const read = () => readJournalStatusIndicators(state, { start: 0, floor: 0, stop }).stopping
  expect(read()).toBe(false)
  state.items.delete('finished')
  expect(read()).toBe(true)
  const send: AgentJournalSubmission = {
    clientMessageId: 'later',
    fence: 0,
    payloadFingerprint: 'later',
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    acceptedSequence: 12
  }
  state.submissions.set('later', send)
  journalInputOrder(state).afterRow(
    state,
    journalDispatchRowBuilder(() => state, {
      clientMessageId: 'later',
      state: 'accepted',
      providerIdentity: null,
      fence: 0
    })(12, 1)
  )
  expect(read()).toBe(false)
  stop.settle = { settling: true }
  expect(read()).toBe(true)
  stop.settle = { settling: false, turnId: 'live' }
  expect(read()).toBe(true)
  expect(
    readJournalStatusIndicators(
      state,
      { start: 0, floor: 0, stop },
      {
        isCurrentItem: () => false,
        owesSend: () => false
      }
    ).stopping
  ).toBe(false)
})
