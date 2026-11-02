import { describe, expect, it } from 'vitest'
import {
  createPluginFrameBlockedTally,
  isPluginFrameCancelledRequestEcho,
  PLUGIN_FRAME_BLOCKED_FLUSH_MS,
  pluginFrameCspBlock,
  pluginFrameRequestBlock
} from './plugin-frame-blocked-requests'

const refusal = (what: string, url: string, directive: string) =>
  `Refused to ${what} '${url}' because it violates the following Content Security Policy directive: "${directive} 'self'".`

describe('plugin frame blocked requests', () => {
  it("reads Chromium's content-policy refusals as a directive and origin", () => {
    expect(
      pluginFrameCspBlock(refusal('load the font', 'https://unpkg.com/x/a.woff2', 'font-src'))
    ).toEqual({
      kind: 'font-src',
      origin: 'https://unpkg.com'
    })
    expect(
      pluginFrameCspBlock(refusal('connect to', 'wss://live.example.com:8443/s', 'connect-src'))
    ).toEqual({
      kind: 'connect-src',
      origin: 'wss://live.example.com:8443'
    })
    expect(
      pluginFrameCspBlock(
        refusal('load the script', 'https://cdn.example.com/a.js', 'script-src-elem')
      )
    ).toEqual({
      kind: 'script-src-elem',
      origin: 'https://cdn.example.com'
    })
    expect(
      pluginFrameCspBlock(
        "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not allowed"
      )
    ).toBeNull()
    expect(pluginFrameCspBlock('Uncaught Error: boom')).toBeNull()
  })

  it('names a cancelled request by the directive its resource type maps to', () => {
    expect(pluginFrameRequestBlock('https://fonts.example.com/a.woff', 'font')).toEqual({
      kind: 'font-src',
      origin: 'https://fonts.example.com'
    })
    expect(pluginFrameRequestBlock('https://x.example.com/', 'other').kind).toBe('request')
    expect(
      isPluginFrameCancelledRequestEcho('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT')
    ).toBe(true)
    expect(isPluginFrameCancelledRequestEcho('Failed to load resource: 404')).toBe(false)
  })

  it('counts per kind and origin, flushes once after the window, then starts over', () => {
    const lines: string[] = []
    const scheduled: { run: () => void; ms: number; cancelled: boolean }[] = []
    const tally = createPluginFrameBlockedTally({
      log: (line) => lines.push(line),
      schedule: (run, ms) => {
        const entry = { run, ms, cancelled: false }
        scheduled.push(entry)
        return () => {
          entry.cancelled = true
        }
      }
    })
    const font = { kind: 'font-src', origin: 'https://unpkg.com' }
    tally.note(font)
    tally.note(font)
    tally.note({ kind: 'img-src', origin: 'https://img.example.com' })
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.ms).toBe(PLUGIN_FRAME_BLOCKED_FLUSH_MS)
    expect(lines).toEqual([])
    scheduled[0]?.run()
    expect(lines).toEqual([
      '[frame] blocked font-src https://unpkg.com (x2): plugin frames have no network',
      '[frame] blocked img-src https://img.example.com: plugin frames have no network'
    ])
    tally.note(font)
    expect(scheduled).toHaveLength(2)
    tally.flush()
    expect(scheduled[1]?.cancelled).toBe(true)
    expect(lines.at(-1)).toBe(
      '[frame] blocked font-src https://unpkg.com: plugin frames have no network'
    )
    tally.flush()
    expect(lines).toHaveLength(3)
  })
})
