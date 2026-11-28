import { expect, it } from 'vitest'
import { usageLimitedUntil } from './bot-look-around-failures'
import { BotLookAroundStore } from './bot-look-around-store'

const RESETS = 5_000_000

// A look its usage limit cut short on the `work` saved account, as the store reads it back.
const saved = JSON.stringify({
  bots: {
    bot: {
      runs: [
        {
          sessionId: 'look-1',
          startedAt: 1_000,
          endedAt: 2_000,
          error: 'usage limit',
          usageLimited: { resetsAt: RESETS, accountId: 'work' }
        }
      ],
      suggestions: []
    }
  }
})
const { runs } = new BotLookAroundStore({ read: () => saved, write: async () => {} }, () => {}).get(
  'bot'
)

it("holds a bot's looks for the limited account, and lifts the hold once another is selected", () => {
  expect(usageLimitedUntil(runs, 'work')).toBe(RESETS)
  // An agent whose accounts no saved account names keeps the reset.
  expect(usageLimitedUntil(runs, undefined)).toBe(RESETS)
  expect(usageLimitedUntil(runs, 'personal')).toBe(0)
})
