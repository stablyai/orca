import { describe, expect, it } from 'vitest'
import { BOT_AGENTS } from '../../shared/bot-types'
import { lookAroundSupported } from '../../shared/bots/bot-look-around'
import { tidyNowRefusal } from './bot-memory-tidy-up'

const idle = { running: false, busy: false }

describe('background runs by agent', () => {
  it.each(BOT_AGENTS)(
    '%s runs memory upkeep; Look around only on Claude Code and Codex',
    (agent) => {
      expect(tidyNowRefusal({ agent, paused: false }, idle)).toBeNull()
      expect(lookAroundSupported(agent)).toBe(agent === 'claude' || agent === 'codex')
    }
  )
})
