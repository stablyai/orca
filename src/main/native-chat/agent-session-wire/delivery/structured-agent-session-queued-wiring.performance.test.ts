// Perf contract for #43145: a drain learns whose cards wait once per queue change, from the table,
// without listing or decoding any card. Fails when the card listing is restored.
import { expect, it, vi } from 'vitest'
import { waitingCards } from './structured-agent-session-queued-wiring'

it.each([10, 100])(
  'answers whose cards wait among %i cards without listing them, once per queue change',
  async (cards) => {
    let revision = 'r1'
    const list = vi.fn(async () => Array.from({ length: cards }, () => ({})))
    const waitingSenders = vi.fn(async () => ({ person: true, other: false }))
    const journal = {
      queuedMessages: { revision: () => revision, waitingSenders, list }
    }

    for (let drain = 0; drain < 10; drain++) {
      expect(await waitingCards(journal)).toEqual({ person: true, other: false })
    }
    revision = 'r2'
    await waitingCards(journal)

    expect(list).not.toHaveBeenCalled()
    expect(waitingSenders).toHaveBeenCalledTimes(2)
  }
)
