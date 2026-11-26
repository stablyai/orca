import { afterEach, describe, expect, it, vi } from 'vitest'
import { botRulesBlock } from './bot-preamble'

// The rules read the flag each time they are built, so one import covers both variants.
const items = vi.hoisted(() => ({ ready: true }))
vi.mock('../../shared/bot-items-ui', () => ({
  get BOT_ITEMS_UI_READY() {
    return items.ready
  }
}))

const BLOCKER_RULE =
  "When mail Orca says goes to a thread is a worker's blocker, or a result that ends one step while more work continues"
const ONCE_PER_ROUND = 'Write it once per round, not once per reviewer'
const AFTER_WORKERS_ITEMS =
  'or a thread you answered is waiting on this work and it hit a blocker or finished a step (see above).'
const AFTER_WORKERS_PLAIN =
  "- After starting workers, end your turn; don't wait on them. Their results arrive as a new message, and your final message then is your reply."

afterEach(() => {
  items.ready = true
})

describe("a bot's rules for the thread a worker's mail goes to", () => {
  it('ask for one line per blocker or finished step, once per round, with items', () => {
    const rules = botRulesBlock('claude')
    expect(rules).toContain(BLOCKER_RULE)
    expect(rules).toContain(ONCE_PER_ROUND)
    expect(rules).toContain(AFTER_WORKERS_ITEMS)
  })

  it('leave the rules without items as they were', () => {
    items.ready = false
    const rules = botRulesBlock('claude')
    expect(rules).not.toContain(BLOCKER_RULE)
    expect(rules).not.toContain(AFTER_WORKERS_ITEMS)
    expect(rules).toContain(AFTER_WORKERS_PLAIN)
  })
})
