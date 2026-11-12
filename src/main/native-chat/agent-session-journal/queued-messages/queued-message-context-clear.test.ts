import { describe, expect, it } from 'vitest'
import { deriveQueuePauses, journalQueuePauseRestatement } from './queued-message-pause'
import { createJournalQueuePauseMarks } from './queued-message-pause-marks'

const card = (messageId: string) => ({
  messageId,
  state: 'waiting',
  holdReason: null,
  queuedAt: { epoch: 'epoch', sequence: 2 }
})
const marks = () => ({
  ...createJournalQueuePauseMarks(),
  cleared: { sequence: 5, operationId: 'clear', messageIds: ['before-one', 'before-two'] }
})
const pauses = (cards = [card('before-one'), card('before-two')], m = marks(), accepted = 0) =>
  deriveQueuePauses({
    epoch: 'epoch',
    marks: m,
    latestAcceptedTurnSequence: accepted,
    cards,
    reopenFloor: null
  })

describe('exact waiting-card membership after context clear', () => {
  it('restates an explicit lift when rewind retires the accepted turn', () => {
    const prior = marks()
    const cards = [card('before-one'), card('before-two')]
    const restated = journalQueuePauseRestatement(prior, 6, pauses(cards, prior, 6)).cleared!
    expect(restated.lifted).toBe(true)
    expect(pauses(cards, { ...prior, cleared: { ...restated, sequence: 10 } }, 0)).toEqual([])
  })
})
