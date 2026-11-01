import { describe, expect, it } from 'vitest'
import {
  deriveQueuePauses,
  nextSendableQueuedCard,
  queuePauseHolding,
  resumableQueuePause
} from './queued-message-pause'

export function registerQueuedMessagePauseHeldCardsTests(): void {
  describe('which cards the pauses in force hold', () => {
    type Card = Parameters<typeof queuePauseHolding>[1] & { messageId: string }

    function card(messageId: string, queuedAfter: number, fields: Partial<Card> = {}): Card {
      const queuedAt = { epoch: 'epoch-1', sequence: queuedAfter + 1 }
      const base = { state: 'waiting', holdReason: null }
      return { messageId, ...base, queuedAt, ...fields }
    }

    /** Simulate Stop/open boundaries with no subsequent turn, Resume or reopen mark. */
    function pausesOver(cards: readonly Card[], stopped = 5, opened = 0, clearedIds?: string[]) {
      return deriveQueuePauses({
        epoch: 'epoch-1',
        marks: {
          latestStop: stopped ? { sequence: stopped, event: { reason: 'user-stop', at: 0 } } : null,
          resumedSequence: 0,
          reopenedSequence: 0,
          ...(clearedIds
            ? { cleared: { sequence: 4, operationId: 'clear', messageIds: clearedIds } }
            : {})
        },
        latestAcceptedTurnSequence: 0,
        cards,
        reopenFloor: opened ? { epoch: 'epoch-1', sequence: opened + 1 } : null
      })
    }

    function holding(
      cards: readonly Card[],
      stopped?: number,
      opened?: number
    ): [string, string | null][] {
      const pauses = pausesOver(cards, stopped, opened)
      return cards.map((each) => [each.messageId, queuePauseHolding(pauses, each)?.reason ?? null])
    }

    it('a Stop holds a card with no recorded position, and one queued before a rewind', () => {
      const cards = [
        card('unrecorded', 5, { queuedAt: null }),
        // Epoch precedence outranks raw sequence values.
        card('before-rewind', 5, { queuedAt: { epoch: 'epoch-0', sequence: 9 } }),
        card('after', 5)
      ]
      expect(holding(cards)).toEqual([
        ['unrecorded', 'stopped'],
        ['before-rewind', 'stopped'],
        ['after', null]
      ])
    })

    it("a Stop that holds nothing never hides a reopen's: a card from before the open waits", () => {
      const after = card('after', 5)
      expect(pausesOver([after], 5, 6).map((pause) => pause.reason)).toEqual([
        'stopped',
        'restarted'
      ])
      expect(holding([after], 5, 6)).toEqual([['after', 'restarted']])
      expect(nextSendableQueuedCard(pausesOver([after], 5, 6), [after])).toBeNull()
      expect(nextSendableQueuedCard(pausesOver([after]), [after])).toBe(after)
    })

    it("a card names the first pause holding it, and the header names the first held card's", () => {
      const cards = [card('before', 3), card('after', 5)]
      expect(holding(cards, 5, 6)).toEqual([
        ['before', 'stopped'],
        ['after', 'restarted']
      ])
      expect(resumableQueuePause(pausesOver(cards, 5, 6), cards)?.reason).toBe('stopped')
    })

    it('a card from before the open waits in order, and so do the cards behind it', () => {
      const cards = [card('kept', 1), card('behind', 2)]
      expect(holding(cards, 0, 4)).toEqual([
        ['kept', 'restarted'],
        ['behind', 'restarted']
      ])
      expect(nextSendableQueuedCard(pausesOver(cards, 0, 4), cards)).toBeNull()
    })

    it('a card held on its own from before the open starts no reopen pause', () => {
      const cards = [card('held', 1, { holdReason: 'send_failed' }), card('live', 5)]
      expect(pausesOver(cards, 0, 4)).toEqual([])
      expect(nextSendableQueuedCard(pausesOver(cards, 0, 4), cards)?.messageId).toBe('live')
    })

    it("a /clear's pause that holds nothing never hides a reopen's", () => {
      const cards = [card('cleared', 1, { holdReason: 'send_failed' }), card('typed', 2)]
      const pauses = pausesOver(cards, 0, 4, ['cleared'])
      expect(pauses.map((pause) => pause.reason)).toEqual(['cleared', 'restarted'])
      expect(
        cards.map((each) => [each.messageId, queuePauseHolding(pauses, each)?.reason ?? null])
      ).toEqual([
        ['cleared', null],
        ['typed', 'restarted']
      ])
      expect(nextSendableQueuedCard(pauses, cards)).toBeNull()
    })
  })
}
