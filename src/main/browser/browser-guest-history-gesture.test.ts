import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_HISTORY_GESTURE_CHANNEL,
  BROWSER_HISTORY_WHEEL_CHANNEL
} from '../../shared/browser-history-gesture'

const { enabled, injecting } = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  injecting: vi.fn(() => false)
}))
vi.mock('electron', () => ({
  systemPreferences: { isSwipeTrackingFromScrollEventsEnabled: enabled }
}))
vi.mock('./agent-input-injection', () => ({ isAgentInjectingInput: injecting }))
import { setupGuestHistoryGesture } from './browser-guest-history-gesture'

function fixture() {
  const emitter = new EventEmitter()
  const frame = {}
  let activeId: number | null = null
  const actions: unknown[][] = []
  const guest = Object.assign(emitter, {
    mainFrame: frame,
    isDestroyed: () => false,
    send: (channel: string, id: number | null) => {
      if (channel === BROWSER_HISTORY_GESTURE_CHANNEL) {
        activeId = id
      }
    },
    navigationHistory: { canGoBack: () => true, canGoForward: () => true }
  })
  const renderer = { send: (...args: unknown[]) => actions.push(args) }
  let preset = false
  const cleanup = setupGuestHistoryGesture({
    browserTabId: 'page-one',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements every WebContents member used by the adapter.
    guest: guest as unknown as Electron.WebContents,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter only calls the renderer's send method.
    resolveRenderer: () => renderer as unknown as Electron.WebContents,
    isViewportPresetActive: () => preset
  })
  return {
    emitter,
    actions,
    cleanup,
    preset: () => {
      preset = true
    },
    input: (type: string) => emitter.emit('input-event', {}, { type }),
    wheel: (overrides: Record<string, unknown> = {}, senderFrame: object = frame) =>
      emitter.emit('ipc-message', { senderFrame }, BROWSER_HISTORY_WHEEL_CHANNEL, {
        gestureId: activeId,
        deltaX: -120,
        deltaY: 0,
        blocked: false,
        ...overrides
      })
  }
}

describe('native browser gesture routing', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    enabled.mockReturnValue(true)
    injecting.mockReturnValue(false)
  })

  it('routes one action to the originating page and rejects momentum after end', () => {
    const f = fixture()
    f.wheel()
    f.input('gestureScrollBegin')
    f.wheel()
    f.wheel()
    f.input('gestureScrollEnd')
    f.wheel()
    expect(f.actions).toEqual([
      ['ui:browserHistoryNavigate', { browserPageId: 'page-one', direction: 'back' }]
    ])
    f.cleanup()
  })

  it('does not allow a child frame or malformed payload to consume the native gesture', () => {
    const f = fixture()
    f.input('gestureScrollBegin')
    f.wheel({}, {})
    f.wheel({ deltaX: Number.NaN })
    f.wheel({ blocked: 'no' })
    expect(f.actions).toEqual([])
    f.wheel({ deltaX: 120 })
    expect(f.actions).toEqual([
      ['ui:browserHistoryNavigate', { browserPageId: 'page-one', direction: 'forward' }]
    ])
    f.cleanup()
  })

  it('respects the system preference, emulation panning, and agent input', () => {
    const f = fixture()
    enabled.mockReturnValue(false)
    f.input('gestureScrollBegin')
    f.wheel()
    enabled.mockReturnValue(true)
    injecting.mockReturnValue(true)
    f.input('gestureScrollBegin')
    f.wheel()
    injecting.mockReturnValue(false)
    f.input('gestureScrollBegin')
    f.preset()
    f.wheel()
    expect(f.actions).toEqual([])
    f.cleanup()
  })

  it('disarms on focus loss, fling and disposal', () => {
    const f = fixture()
    f.input('gestureScrollBegin')
    f.emitter.emit('blur')
    f.wheel()
    f.input('gestureScrollBegin')
    f.input('gestureFlingStart')
    f.wheel()
    f.input('gestureScrollBegin')
    f.cleanup()
    f.wheel()
    expect(f.actions).toEqual([])
    expect(f.emitter.eventNames()).toEqual([])
  })

  it('leaves non-macOS guest input untouched', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const f = fixture()
    expect(f.emitter.eventNames()).toEqual([])
    f.input('gestureScrollBegin')
    f.wheel()
    expect(f.actions).toEqual([])
    f.cleanup()
  })
})
