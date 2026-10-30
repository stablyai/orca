import { describe, expect, it } from 'vitest'
import {
  createJournalQueuePauseMarks,
  deriveQueuePauses,
  journalQueuePauseRestatement,
  queuePauseHolding,
  nextSendableQueuedCard
} from './queued-message-pause'

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
  it('holds only recorded waiting IDs and intersects them with cards still waiting', () => {
    const after = card('after')
    const current = [card('before-two'), after]
    const held = pauses(current)
    expect(held).toEqual([
      { reason: 'cleared', since: { epoch: 'epoch', sequence: 5 }, messageIds: ['before-two'] }
    ])
    expect(queuePauseHolding(held, after)).toBeUndefined()
    expect(nextSendableQueuedCard(held, current)).toBeNull()
    expect(pauses([after])).toEqual([])
    expect(nextSendableQueuedCard(pauses([after]), [after])).toEqual(after)
  })

  it('a removed or returned member cannot strand the clear pause', () => {
    const returned = { ...card('before-one'), state: 'returned' }
    expect(
      deriveQueuePauses({
        epoch: 'epoch',
        marks: marks(),
        latestAcceptedTurnSequence: 0,
        cards: [returned],
        reopenFloor: null
      })
    ).toEqual([])
    expect(pauses([])).toEqual([])
  })

  it('ends on a new accepted turn or Resume, while older acceptance does not lift it', () => {
    expect(pauses(undefined, undefined, 4)).toHaveLength(1)
    expect(pauses(undefined, undefined, 6)).toEqual([])
    expect(pauses(undefined, { ...marks(), resumedSequence: 6 })).toEqual([])
  })

  it('restates an explicit lift when rewind retires the accepted turn', () => {
    const prior = marks()
    const cards = [card('before-one'), card('before-two')]
    const restated = journalQueuePauseRestatement(prior, 6, pauses(cards, prior, 6)).cleared!
    expect(restated.lifted).toBe(true)
    expect(pauses(cards, { ...prior, cleared: { ...restated, sequence: 10 } }, 0)).toEqual([])
  })

  it('restates only still-held IDs when rewind changes the journal suffix', () => {
    const prior = marks()
    const current = [card('before-two')]
    expect(journalQueuePauseRestatement(prior, 0, pauses(current, prior)).cleared).toEqual({
      operationId: 'clear',
      messageIds: ['before-two']
    })
  })
})
