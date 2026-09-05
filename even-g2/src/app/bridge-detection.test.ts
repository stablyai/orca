// Finding #7: a slow-but-present real bridge must never be silently swapped for the canvas
// simulator on a real device. detectGlassesBridge accepts an isSimulatorFallbackAllowed
// override for testing, avoiding real EvenAppBridge/1500ms timers.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlassesBridge } from '../glasses/glasses-bridge'
import type * as BridgeDetectionModule from './bridge-detection'

vi.mock('../glasses/even-hub-bridge', () => ({
  connectEvenHubBridge: vi.fn()
}))

async function importFresh(): Promise<typeof BridgeDetectionModule> {
  vi.resetModules()
  return import('./bridge-detection')
}

describe('detectGlassesBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.getElementById('app')?.remove()
  })

  it('returns the real bridge immediately when it connects before the timeout', async () => {
    const { connectEvenHubBridge } = await import('../glasses/even-hub-bridge')
    const fakeBridge = {} as GlassesBridge
    vi.mocked(connectEvenHubBridge).mockResolvedValue(fakeBridge)
    const { detectGlassesBridge } = await importFresh()

    const bridge = await detectGlassesBridge({ isSimulatorFallbackAllowed: () => false })
    expect(bridge).toBe(fakeBridge)
  })

  it('falls back to the mock bridge on timeout when simulator fallback is allowed', async () => {
    vi.useFakeTimers()
    const { connectEvenHubBridge } = await import('../glasses/even-hub-bridge')
    vi.mocked(connectEvenHubBridge).mockReturnValue(new Promise(() => {})) // never resolves
    const { detectGlassesBridge } = await importFresh()

    const promise = detectGlassesBridge({ isSimulatorFallbackAllowed: () => true })
    await vi.advanceTimersByTimeAsync(1500)
    vi.useRealTimers()

    const bridge = await promise
    expect(bridge).toBeDefined()
    // MockGlassesBridge exposes flushRenders/pageSnapshot; the real bridge type doesn't.
    expect(typeof (bridge as unknown as { flushRenders?: unknown }).flushRenders).toBe('function')
  })

  it('never falls back to the simulator on a real device (finding #7) and keeps waiting', async () => {
    const { connectEvenHubBridge } = await import('../glasses/even-hub-bridge')
    let resolveReal!: (bridge: GlassesBridge) => void
    vi.mocked(connectEvenHubBridge).mockReturnValue(
      new Promise((resolve) => {
        resolveReal = resolve
      })
    )
    const { detectGlassesBridge } = await importFresh()

    const mount = document.createElement('div')
    mount.id = 'app'
    document.body.appendChild(mount)

    vi.useFakeTimers()
    const promise = detectGlassesBridge({ isSimulatorFallbackAllowed: () => false })
    await vi.advanceTimersByTimeAsync(1500)
    vi.useRealTimers()
    await Promise.resolve()

    // Still waiting past the timeout — recoverable notice shown, no simulator installed.
    expect(mount.querySelector('.glasses-bridge-unavailable')).not.toBeNull()

    const fakeBridge = {} as GlassesBridge
    resolveReal(fakeBridge)
    const bridge = await promise

    expect(bridge).toBe(fakeBridge)
    expect(mount.querySelector('.glasses-bridge-unavailable')).toBeNull()
  })

  it('throws when the real bridge ultimately never appears and fallback is not allowed', async () => {
    const { connectEvenHubBridge } = await import('../glasses/even-hub-bridge')
    // Resolves quickly to null (e.g. connectEvenHubBridge's own rejection, caught upstream), so
    // the race settles from `real` — fake timers just guarantee no dangling real 1500ms timer.
    vi.mocked(connectEvenHubBridge).mockResolvedValue(null as unknown as GlassesBridge)
    const { detectGlassesBridge } = await importFresh()

    vi.useFakeTimers()
    try {
      await expect(
        detectGlassesBridge({ isSimulatorFallbackAllowed: () => false })
      ).rejects.toThrow('Glasses bridge unavailable')
    } finally {
      vi.useRealTimers()
    }
  })
})
