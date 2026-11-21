import { describe, expect, it } from 'vitest'
import type { BotItemStatus } from '../../shared/bots/bot-items'
import { SALVAGE } from './bot-memory-salvage'
import { salvageOffer, type SalvageOfferDeps } from './bot-memory-salvage-offer'
import { BotSalvageStore } from './bot-memory-salvage-store'
import { statusMigrationPlan } from './bot-memory-status-migration'

const DAY = 86_400_000
const DECISION = "- 2026-11-03 PR #5900 merged; Dana picked: 'CSV first' after round C2"
const SECOND = "- 2026-11-04 PR #5902 merged; owner decided: 'skip the tour' (item 601)"
const STATUS = '- 2026-11-05 worker ctx_ab12cd34 pending on #5904'

function world(options: { chat?: boolean } = {}) {
  let now = Date.UTC(2026, 10, 21)
  const store = new BotSalvageStore({ read: async () => null, write: async () => {} })
  const journal = new Map([['2026-11', ['# Status moved', DECISION, SECOND, STATUS]]])
  const memory: string[] = []
  const item = {
    status: null as BotItemStatus | null,
    question: 0,
    comments: [] as { id: number; text: string }[]
  }
  const asked: { title: string; description: string }[] = []
  const closes: { to: string; note: string }[] = []
  let failRestore = 0
  let nextEvent = 10
  const deps: SalvageOfferDeps = {
    store,
    items: {
      ask: async (_botId, text) => {
        if (options.chat === false) {
          return null
        }
        asked.push(text)
        Object.assign(item, { status: 'needs_you', question: nextEvent++, comments: [] })
        return { uid: 'u1', number: 700, question: item.question }
      },
      reask: async () => {
        item.question = nextEvent++
        return item.question
      },
      close: async (_uid, to, note) => {
        closes.push({ to, note })
        item.status = to
      },
      status: async () => item.status,
      ownerComments: async (_uid, after) => item.comments.filter(({ id }) => id > after)
    },
    journal: async () => journal,
    restore: async (_botId, line) => {
      if (failRestore > 0) {
        failRestore--
        throw new Error('busy')
      }
      if (memory.includes(line)) {
        return 'kept-already-present'
      }
      memory.push(line)
      return 'kept'
    },
    ownerNames: async () => ['Dana'],
    now: () => now
  }
  // Event ids grow in time order across questions and comments, as in the items store.
  const answer = (text: string) => void item.comments.push({ id: nextEvent++, text })
  return {
    store,
    deps,
    memory,
    item,
    asked,
    closes,
    journal,
    answer,
    failNextRestore: () => (failRestore = 1),
    later: (ms: number) => (now += ms),
    states: async () =>
      Object.fromEntries(
        Object.values((await store.get('b1')).sources).map(({ line, state }) => [line, state])
      ),
    moved: (...lines: string[]) => store.recordMoved('b1', '2026-11', lines, now)
  }
}

describe('salvage offers decisions the status move took', () => {
  it('asks the owner about the lines that read as decisions, word for word, and nothing else', async () => {
    const w = world()
    await w.moved(DECISION, SECOND, STATUS)
    await salvageOffer('b1', w.deps)
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0].description).toContain(`1. \` ${DECISION} \` (journal 2026-11)`)
    expect(w.asked[0].description).toContain(`2. \` ${SECOND} \``)
    expect(w.asked[0].description).not.toContain('ctx_ab12cd34')
    expect(await w.states()).toEqual({
      [DECISION]: 'proposed',
      [SECOND]: 'proposed',
      [STATUS]: 'non-candidate'
    })
    expect(w.memory).toEqual([])
  })

  it('puts back exactly the kept lines on "Keep all", then closes the item', async () => {
    const w = world()
    await w.moved(DECISION, SECOND)
    await salvageOffer('b1', w.deps)
    w.answer('Keep all')
    await salvageOffer('b1', w.deps)
    expect(w.memory).toEqual([DECISION, SECOND])
    expect(w.closes).toEqual([{ to: 'done', note: 'Kept 2 in memory.' }])
    expect((await w.store.get('b1')).proposal).toBeNull()
  })

  it('keeps only the numbers named, declines the rest, and reads only the first answer', async () => {
    const w = world()
    await w.moved(DECISION, SECOND)
    await salvageOffer('b1', w.deps)
    w.answer('2')
    w.answer('Keep all')
    await salvageOffer('b1', w.deps)
    expect(w.memory).toEqual([SECOND])
    expect(await w.states()).toEqual({ [DECISION]: 'declined', [SECOND]: 'kept' })
  })

  it('asks once more after an unreadable answer, and never reuses it', async () => {
    const w = world()
    await w.moved(DECISION)
    await salvageOffer('b1', w.deps)
    w.answer('keep all except the first')
    await salvageOffer('b1', w.deps)
    expect(w.memory).toEqual([])
    expect(w.closes).toEqual([])
    // Read again with no new answer: the first one is never taken twice.
    await salvageOffer('b1', w.deps)
    expect(w.closes).toEqual([])
    w.answer('sure')
    await salvageOffer('b1', w.deps)
    expect(w.memory).toEqual([])
    expect(w.closes.map(({ to }) => to)).toEqual(['canceled'])
    expect(await w.states()).toEqual({ [DECISION]: 'declined' })
  })

  it('offers an unanswered line again after 14 days, first, and settles it after a second expiry', async () => {
    const w = world()
    await w.moved(DECISION)
    await salvageOffer('b1', w.deps)
    w.later(SALVAGE.expiresMs)
    await salvageOffer('b1', w.deps)
    expect(w.closes.map(({ to }) => to)).toEqual(['canceled'])
    expect(w.asked).toHaveLength(2)
    w.later(SALVAGE.expiresMs)
    await salvageOffer('b1', w.deps)
    expect(await w.states()).toEqual({ [DECISION]: 'expired' })
    w.later(SALVAGE.everyMs)
    await salvageOffer('b1', w.deps)
    expect(w.asked).toHaveLength(2)
  })

  it('makes no proposal more than once a week, nor without a chat to put it in', async () => {
    const w = world()
    await w.moved(DECISION)
    await salvageOffer('b1', w.deps)
    w.answer('none')
    await salvageOffer('b1', w.deps)
    await w.moved(SECOND)
    await salvageOffer('b1', w.deps)
    expect(w.asked).toHaveLength(1)
    w.later(SALVAGE.everyMs)
    await salvageOffer('b1', w.deps)
    expect(w.asked).toHaveLength(2)

    const none = world({ chat: false })
    await none.moved(DECISION)
    await salvageOffer('b1', none.deps)
    expect(await none.states()).toEqual({ [DECISION]: 'candidate' })
  })

  it("never puts back a line that's gone from the journal", async () => {
    const w = world()
    await w.moved(DECISION)
    await salvageOffer('b1', w.deps)
    w.journal.set('2026-11', [])
    w.answer('1')
    await salvageOffer('b1', w.deps)
    expect(w.memory).toEqual([])
    expect(w.closes).toEqual([
      { to: 'done', note: 'Kept 0 in memory; 1 could not be put back as written.' }
    ])
  })

  it('finishes a restore that failed on the next pass, writing each line once', async () => {
    const w = world()
    await w.moved(DECISION, SECOND)
    await salvageOffer('b1', w.deps)
    w.answer('all')
    w.failNextRestore()
    await salvageOffer('b1', w.deps)
    expect(w.memory).toEqual([SECOND])
    expect(w.closes).toEqual([])
    await salvageOffer('b1', w.deps)
    expect(w.memory).toEqual([SECOND, DECISION])
    expect(w.closes).toEqual([{ to: 'done', note: 'Kept 2 in memory.' }])
  })

  it('takes an item the owner closed without an answer as nothing kept', async () => {
    const w = world()
    await w.moved(DECISION)
    await salvageOffer('b1', w.deps)
    w.item.status = 'canceled'
    await salvageOffer('b1', w.deps)
    expect(await w.states()).toEqual({ [DECISION]: 'declined' })
    expect(w.closes).toEqual([])
  })
})

describe('a kept line, at the next status move', () => {
  it('stays in MEMORY.md', () => {
    const memory = ['# Memory', DECISION, STATUS, ''].join('\n')
    const plan = statusMigrationPlan(memory, '2026-11-22', new Set([DECISION]))
    expect(plan?.change.removed.map(({ line }) => line)).toEqual([STATUS])
  })
})
