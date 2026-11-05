import { afterEach, describe, expect, it } from 'vitest'
import { pluginFrameKey } from '../../../shared/plugins/frames/plugin-frame-guest'
import {
  PLUGIN_FRAME_CONSOLE_BURST_LIMIT,
  PLUGIN_FRAME_CONSOLE_WINDOW_MS,
  createPluginFrameConsoleLimiter,
  formatPluginFrameConsoleLine,
  setPluginFrameGuestLogSink
} from './plugin-frame-guest-diagnostics'

const KEY = pluginFrameKey('acme.notes')

const ORIGIN = `orca-plugin-frame://${KEY}`

function consoleEvent(level: string, message: string, sourceId = `${ORIGIN}/src/panel.tsx`) {
  return { level, message, lineNumber: 12, sourceId }
}

afterEach(() => setPluginFrameGuestLogSink(null))

describe('plugin frame console formatting', () => {
  it('truncates a huge message', () => {
    const line = formatPluginFrameConsoleLine(consoleEvent('error', 'x'.repeat(10_000)), KEY)?.line
    expect(line?.length).toBeLessThan(2100)
    expect(line?.endsWith('(truncated)')).toBe(true)
  })
})

describe('plugin frame console limiter', () => {
  it('allows a burst, notices once, drops the rest, then resets with the window', () => {
    let now = 1_000
    const limit = createPluginFrameConsoleLimiter(() => now)
    const verdicts = Array.from({ length: PLUGIN_FRAME_CONSOLE_BURST_LIMIT + 3 }, () => limit())
    expect(verdicts.filter((verdict) => verdict === 'log')).toHaveLength(
      PLUGIN_FRAME_CONSOLE_BURST_LIMIT
    )
    expect(verdicts.slice(PLUGIN_FRAME_CONSOLE_BURST_LIMIT)).toEqual(['notice', 'drop', 'drop'])
    now += PLUGIN_FRAME_CONSOLE_WINDOW_MS
    expect(limit()).toBe('log')
  })
})
