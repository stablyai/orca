import { expect, it } from 'vitest'
import {
  createQueuePauseContext,
  queuePauseHoldingInContext,
  resumableQueuePause
} from './queued-message-pause'
import { createJournalQueuePauseMarks } from './queued-message-pause-marks'

const marks = createJournalQueuePauseMarks()

function card(messageId: string, redirectedPastFailure?: { epoch: string; sequence: number }) {
  return {
    messageId,
    state: 'waiting',
    holdReason: null,
    queuedAt: { epoch: 'e', sequence: 12 },
    unattended: false,
    ...(redirectedPastFailure ? { redirectedPastFailure } : {})
  }
}

it('lets a send the account move turned into a card pass only the failure it was sent after', () => {
  const failedAt11 = createQueuePauseContext({
    epoch: 'e',
    marks,
    latestAcceptedTurnSequence: 9,
    failedAt: 11,
    reopenFloor: null
  })
  const redirected = card('redirected', { epoch: 'e', sequence: 11 })
  const holds = (context: typeof failedAt11, row: ReturnType<typeof card>) =>
    queuePauseHoldingInContext(context, row)?.reason ?? null

  expect(holds(failedAt11, redirected)).toBeNull()
  // Queued on purpose, or written before the witness existed: the failure still holds it.
  expect(holds(failedAt11, card('queued'))).toBe('failed')
  // Only the redirected card waits, so nothing asks the person to Resume.
  expect(resumableQueuePause(failedAt11.pauses, [redirected])).toBeNull()
  expect(resumableQueuePause(failedAt11.pauses, [redirected, card('queued')])?.reason).toBe(
    'failed'
  )

  const failedAgain = createQueuePauseContext({
    epoch: 'e',
    marks,
    latestAcceptedTurnSequence: 14,
    failedAt: 15,
    reopenFloor: null
  })
  expect(holds(failedAgain, redirected)).toBe('failed')
  expect(holds(failedAt11, card('other-epoch', { epoch: 'older', sequence: 11 }))).toBe('failed')

  const stopped = createQueuePauseContext({
    epoch: 'e',
    marks: { ...marks, latestStop: { sequence: 13, event: { reason: 'user-stop', at: 1 } } },
    latestAcceptedTurnSequence: 9,
    failedAt: 11,
    reopenFloor: null
  })
  expect(holds(stopped, redirected)).toBe('stopped')
})
