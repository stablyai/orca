import { describe, expect, it } from 'vitest'
import {
  createPluginFrameBlockedTally,
  isPluginFrameCancelledRequestEcho,
  PLUGIN_FRAME_BLOCKED_FLUSH_MS,
  PLUGIN_FRAME_BLOCKED_MAX_LINES,
  pluginFrameCspBlock,
  pluginFrameRequestBlock
} from './plugin-frame-blocked-requests'

const refusal = (what: string, url: string, directive: string) =>
  `Refused to ${what} '${url}' because it violates the following Content Security Policy directive: "${directive} 'self'".`

// Verbatim from Electron 43's console-message for a guest with `default-src 'none'`.
const ELECTRON_43_REFUSALS: [string, string, string][] = [
  [
    `Loading the font 'https://fonts.example.com/a.woff2' violates the following Content Security Policy directive: "default-src 'none'". Note that 'font-src' was not explicitly set, so 'default-src' is used as a fallback. The action has been blocked.`,
    'font-src',
    'https://fonts.example.com'
  ],
  [
    `Loading the stylesheet 'https://cdn.example.com/a.css' violates the following Content Security Policy directive: "style-src 'unsafe-inline'". Note that 'style-src-elem' was not explicitly set, so 'style-src' is used as a fallback. The action has been blocked.`,
    'style-src-elem',
    'https://cdn.example.com'
  ],
  [
    `Connecting to 'wss://ws.example.com/' violates the following Content Security Policy directive: "default-src 'none'". Note that 'connect-src' was not explicitly set, so 'default-src' is used as a fallback. The action has been blocked.`,
    'connect-src',
    'wss://ws.example.com'
  ],
  [
    `Loading media from  'https://media.example.com/a.mp4' violates the following Content Security Policy directive: "default-src 'none'". Note that 'media-src' was not explicitly set, so 'default-src' is used as a fallback. The action has been blocked.`,
    'media-src',
    'https://media.example.com'
  ],
  [
    `Framing 'https://frame.example.com/' violates the following Content Security Policy directive: "default-src 'none'". The request has been blocked. Note that 'frame-src' was not explicitly set, so 'default-src' is used as a fallback.`,
    'frame-src',
    'https://frame.example.com'
  ],
  [
    `Fetching content from 'https://pre.example.com/p.js' violates the following Content Security Policy directive: "default-src 'none'". The action has been blocked.`,
    'default-src',
    'https://pre.example.com'
  ]
]

describe('plugin frame blocked requests', () => {
  it.each(ELECTRON_43_REFUSALS)('reads current Chromium wording: %s', (message, kind, origin) => {
    expect(pluginFrameCspBlock(message)).toEqual({ kind, origin })
  })

  it("treats fetch's repeat of a counted refusal as an echo", () => {
    expect(
      isPluginFrameCancelledRequestEcho(
        "Fetch API cannot load https://api.example.com/x. Refused to connect because it violates the document's Content Security Policy."
      )
    ).toBe(true)
  })

  it('keeps a bounded number of origins and folds the rest into one line', () => {
    const lines: string[] = []
    const tally = createPluginFrameBlockedTally({
      log: (line) => lines.push(line),
      schedule: () => () => {}
    })
    tally.note({ kind: 'font-src', origin: 'https://busy.example.com' })
    tally.note({ kind: 'font-src', origin: 'https://busy.example.com' })
    for (let index = 0; index < 250; index += 1) {
      tally.note({ kind: 'img-src', origin: `https://cdn${index}.example.com` })
    }
    tally.flush()
    expect(lines).toHaveLength(PLUGIN_FRAME_BLOCKED_MAX_LINES + 1)
    expect(lines[0]).toContain('https://busy.example.com (x2)')
    expect(lines.at(-1)).toBe(
      `[frame] blocked ${250 - (PLUGIN_FRAME_BLOCKED_MAX_LINES - 1)} more requests to other origins`
    )
  })

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
