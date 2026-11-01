import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginFrameKey } from '../../../shared/plugins/frames/plugin-frame-guest'
import {
  PLUGIN_FRAME_CONSOLE_BURST_LIMIT,
  PLUGIN_FRAME_CONSOLE_WINDOW_MS,
  createPluginFrameConsoleLimiter,
  formatPluginFrameConsoleLine,
  installPluginFrameGuestDiagnostics,
  openPluginFrameGuestDevTools,
  pluginFrameSourceLocation,
  setPluginFrameGuestLogSink,
  shortenPluginFrameUrls
} from './plugin-frame-guest-diagnostics'

const KEY = pluginFrameKey('acme.notes')
const OTHER = pluginFrameKey('acme.other')
const ORIGIN = `orca-plugin-frame://${KEY}`

class FakeGuest extends EventEmitter {
  destroyed = false
  readonly openDevTools = vi.fn()
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function fake(guest: FakeGuest): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer uses only on/once/isDestroyed/openDevTools, which FakeGuest defines.
  return guest as unknown as Electron.WebContents
}

function consoleEvent(level: string, message: string, sourceId = `${ORIGIN}/src/panel.tsx`) {
  return { level, message, lineNumber: 12, sourceId }
}

afterEach(() => setPluginFrameGuestLogSink(null))

describe('plugin frame console formatting', () => {
  it('reduces the source URL to the plugin-relative file and line', () => {
    expect(pluginFrameSourceLocation(`${ORIGIN}/src/My%20Panel.tsx?rev=abc`, 7, KEY)).toBe(
      'src/My Panel.tsx:7'
    )
    expect(pluginFrameSourceLocation(`${ORIGIN}/panel.js`, 0, KEY)).toBe('panel.js')
  })

  it('omits a location from another origin or an Orca-shipped file', () => {
    expect(pluginFrameSourceLocation(`orca-plugin-frame://${OTHER}/a.js`, 1, KEY)).toBeNull()
    expect(pluginFrameSourceLocation(`${ORIGIN}/__orca/orca-runtime.mjs`, 300, KEY)).toBeNull()
    expect(pluginFrameSourceLocation('', 1, KEY)).toBeNull()
  })

  it('shortens frame URLs inside stack traces and drops the revision query', () => {
    const stack = `Error: boom\n    at Panel (${ORIGIN}/src/panel.tsx?rev=dev-1234:12:5)\n    at ${ORIGIN}/lib/x.ts:3:1`
    expect(shortenPluginFrameUrls(stack, KEY)).toBe(
      'Error: boom\n    at Panel (src/panel.tsx:12:5)\n    at lib/x.ts:3:1'
    )
  })

  it("drops Orca's own runtime frames and sourceless engine frames from a logged stack", () => {
    const stack = [
      'Uncaught Error: boom',
      `    at Panel (${ORIGIN}/src/panel.tsx?rev=1:12:5)`,
      `    at evaluate (${ORIGIN}/__orca/orca-runtime.mjs:120:7)`,
      '    at Array.forEach (<anonymous>)',
      '    at new Promise (<anonymous>)',
      '    at <anonymous>',
      '    at Array.map (native)',
      `    at ${ORIGIN}/__orca/orca-runtime.mjs:300:1`
    ].join('\n')
    expect(
      formatPluginFrameConsoleLine(consoleEvent('error', stack, `${ORIGIN}/__orca/x.mjs`), KEY)
    ).toEqual({
      level: 'error',
      line: '[frame] Uncaught Error: boom\n    at Panel (src/panel.tsx:12:5)'
    })
  })

  it('keeps errors and warnings, maps the level, and ignores info and debug', () => {
    expect(
      formatPluginFrameConsoleLine(consoleEvent('error', 'Uncaught TypeError: x'), KEY)
    ).toEqual({ level: 'error', line: '[frame] src/panel.tsx:12 Uncaught TypeError: x' })
    expect(formatPluginFrameConsoleLine(consoleEvent('warning', 'careful'), KEY)?.level).toBe(
      'warn'
    )
    expect(formatPluginFrameConsoleLine(consoleEvent('info', 'hi'), KEY)).toBeNull()
    expect(formatPluginFrameConsoleLine(consoleEvent('debug', 'hi'), KEY)).toBeNull()
  })

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

describe('installPluginFrameGuestDiagnostics', () => {
  it("routes a guest's console errors into its own plugin's log, rate-limited", () => {
    const lines: [string, string, string][] = []
    setPluginFrameGuestLogSink((pluginKey) => (level, line) => lines.push([pluginKey, level, line]))
    const guest = new FakeGuest()
    installPluginFrameGuestDiagnostics(fake(guest), KEY, 'acme.notes')
    guest.emit(
      'console-message',
      consoleEvent('error', `Uncaught (in promise) Error: no\n    at ${ORIGIN}/a.ts:1:2`)
    )
    guest.emit('console-message', consoleEvent('info', 'ignored'))
    expect(lines).toEqual([
      [
        'acme.notes',
        'error',
        '[frame] src/panel.tsx:12 Uncaught (in promise) Error: no\n    at a.ts:1:2'
      ]
    ])
    for (let index = 0; index < PLUGIN_FRAME_CONSOLE_BURST_LIMIT * 3; index += 1) {
      guest.emit('console-message', consoleEvent('error', `spam ${index}`))
    }
    expect(lines.length).toBe(PLUGIN_FRAME_CONSOLE_BURST_LIMIT + 1)
    expect(lines.at(-1)?.[2]).toMatch(/dropping the rest of this window/)
  })

  it('opens DevTools only for live guests of the named plugin', () => {
    const first = new FakeGuest()
    const second = new FakeGuest()
    const other = new FakeGuest()
    installPluginFrameGuestDiagnostics(fake(first), KEY, 'acme.notes2')
    installPluginFrameGuestDiagnostics(fake(second), KEY, 'acme.notes2')
    installPluginFrameGuestDiagnostics(fake(other), OTHER, 'acme.other')
    second.destroy()
    expect(openPluginFrameGuestDevTools('acme.notes2')).toBe(1)
    expect(first.openDevTools).toHaveBeenCalledWith({ mode: 'detach' })
    expect(second.openDevTools).not.toHaveBeenCalled()
    expect(other.openDevTools).not.toHaveBeenCalled()
    first.destroy()
    expect(openPluginFrameGuestDevTools('acme.notes2')).toBe(0)
  })
})
