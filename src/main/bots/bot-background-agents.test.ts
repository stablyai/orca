import { describe, expect, it } from 'vitest'
import { BOT_AGENTS } from '../../shared/bot-types'
import { lookAroundSupported } from '../../shared/bots/bot-look-around'
import { tidyNowRefusal, tidyUpOfferedNow, tidyUpOwed } from './bot-memory-tidy-up'

const idle = { running: false, busy: false }
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime()

describe('background runs by agent', () => {
  it.each(BOT_AGENTS)(
    '%s runs memory upkeep; Look around only on Claude Code and Codex',
    (agent) => {
      expect(tidyNowRefusal({ agent, paused: false }, idle)).toBeNull()
      expect(lookAroundSupported(agent)).toBe(agent === 'claude' || agent === 'codex')
    }
  )

  it('first runs an existing bot on a newly supported agent at the next night, not at once', () => {
    const bot = { agent: 'opencode' as const, createdAt: at(1, 9) }
    const noon = at(20, 12)
    const offered = tidyUpOfferedNow(bot, { runs: [] }, noon)
    expect(offered).toEqual({ runs: [], offeredAt: noon })
    expect(tidyUpOwed(bot, offered!, noon + 60_000)).toBe(false)
    expect(tidyUpOwed(bot, offered!, at(21, 3) + 60_000)).toBe(true)
    // Never stamped again, and never for agents that tidied before or a bot that set it.
    expect(tidyUpOfferedNow(bot, offered!, at(21, 4))).toBeNull()
    expect(tidyUpOfferedNow({ agent: 'claude' }, { runs: [] }, noon)).toBeNull()
    // Offered inside a night's window, it waits for the next night's.
    const night = tidyUpOfferedNow(bot, { runs: [] }, at(20, 4))!
    expect(tidyUpOwed(bot, night, at(20, 4) + 60_000)).toBe(false)
    expect(tidyUpOwed(bot, night, at(20, 7))).toBe(false)
    expect(tidyUpOwed(bot, night, at(21, 3) + 60_000)).toBe(true)
    expect(tidyUpOfferedNow({ agent: 'grok', tidyUp: { on: true } }, { runs: [] }, noon)).toBeNull()
  })
})
