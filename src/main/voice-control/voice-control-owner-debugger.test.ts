import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { VoiceScreenDriver } from './voice-control-screen-driver'
import { createVoiceOwnerDebuggerCache } from './voice-control-owner-debugger'

vi.mock('../browser/guest-cdp-command', () => ({
  // The transport delegates to the fake webContents' own handler, like the real bridge.
  sendGuestCdpCommandWithTimeout: (
    webContents: { __cdp: (method: string, params?: Record<string, unknown>) => unknown },
    method: string,
    params?: Record<string, unknown>
  ) => Promise.resolve(webContents.__cdp(method, params))
}))

type FakeWebContents = {
  isDestroyed: () => boolean
  debugger: {
    isAttached: () => boolean
    attach: (protocolVersion: string) => void
    on: (event: 'detach', listener: () => void) => void
  }
  __cdp: (method: string, params?: Record<string, unknown>) => unknown
  readonly attachCalls: number
}

function fakeWebContents(): FakeWebContents {
  const state = { attached: false, attachCalls: 0 }
  return {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => state.attached,
      attach: () => {
        state.attached = true
        state.attachCalls += 1
      },
      on: vi.fn()
    },
    __cdp: (method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: '$ date\nFri Oct  9 14:37:14 EDT 2026\n' } }
      }
      throw new Error(`unexpected CDP method ${method}`)
    },
    get attachCalls() {
      return state.attachCalls
    }
  }
}

describe('createVoiceOwnerDebuggerCache', () => {
  it('returns the same wrapper for the same webContents, a new one for another', () => {
    const cache = createVoiceOwnerDebuggerCache()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper reads only debugger/isDestroyed off WebContents; the fake covers exactly that surface.
    const first = fakeWebContents() as unknown as WebContents
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same narrow fake surface as above.
    const second = fakeWebContents() as unknown as WebContents
    expect(cache.forWebContents(first)).toBe(cache.forWebContents(first))
    expect(cache.forWebContents(second)).not.toBe(cache.forWebContents(first))
  })

  // Live failure this pins: the wiring returned a FRESH wrapper per getDebugger() call,
  // so the driver identity check never recognized its own attachment — every read after
  // the first was refused as 'refused-devtools-held' with no DevTools anywhere.
  it('a driver over the cached wrapper reads twice without refusing its own attachment', async () => {
    const cache = createVoiceOwnerDebuggerCache()
    const webContents = fakeWebContents()
    const driver = new VoiceScreenDriver({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same narrow fake surface as above.
      getDebugger: () => cache.forWebContents(webContents as unknown as WebContents),
      settleMs: 0
    })
    expect(await driver.readTerminalText()).toContain('Fri Oct  9')
    expect(await driver.readTerminalText()).toContain('Fri Oct  9')
    expect(webContents.attachCalls).toBe(1)
  })
})
