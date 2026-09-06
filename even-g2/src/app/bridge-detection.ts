// Integrator wiring (Unit 8, spec S4/S10 step 1): races the real EvenHub bridge against a
// 1500ms timeout. On timeout, falls back to MockGlassesBridge + the canvas preview via a
// dynamic import (so the prod bundle never carries simulator code) — but only on an EXPLICIT
// simulator opt-in (findings #7 and #17 of the critical review): a slow-but-present bridge on
// real hardware is not evidence it's absent, and neither is `import.meta.env.DEV` — a real
// device loading the dev server would otherwise fall into the simulator too. Silently swapping
// in the simulator there would show a fake HUD on real glasses. Without the opt-in we keep
// waiting for the real bridge instead, surfacing a recoverable notice in the meantime.
import type { GlassesBridge } from '../glasses/glasses-bridge'
import { connectEvenHubBridge } from '../glasses/even-hub-bridge'

const BRIDGE_DETECT_TIMEOUT_MS = 1500

async function fallbackToMockBridge(): Promise<GlassesBridge> {
  const [{ MockGlassesBridge }, { createGlassesCanvasPreview }] = await Promise.all([
    import('../sim/mock-glasses-bridge'),
    import('../sim/glasses-canvas-preview')
  ])
  const bridge = new MockGlassesBridge()
  const mount = document.getElementById('app')
  const preview = mount ? createGlassesCanvasPreview(mount) : null
  if (preview) {
    bridge.setOnRepaint(() => {
      const page = bridge.pageSnapshot()
      if (page) {
        preview.paint(page, { listSelectedIndex: bridge.getListSelection() })
      }
    })
    const tick = (): void => {
      bridge.flushRenders()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  return bridge
}

/** True only on an EXPLICIT simulator opt-in: a `?sim`/`#sim` URL param, or a `sim` flag left in
 *  localStorage by a previous opt-in (finding #17). `import.meta.env.DEV` is NOT sufficient —
 *  a real device loading the dev server (e.g. during on-glasses testing) must never be treated
 *  as "safe to fall back to the mock" just because the bundle was built in dev mode. Never true
 *  in a plain production or dev build with no explicit opt-in. */
export function isSimulatorFallbackAllowed(): boolean {
  if (typeof location !== 'undefined') {
    try {
      if (new URLSearchParams(location.search).has('sim')) {
        return true
      }
    } catch {
      // fall through to hash/localStorage checks
    }
    const hash = location.hash ?? ''
    if (hash === '#sim' || hash.startsWith('#sim&') || hash.startsWith('#sim,')) {
      return true
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem('sim') === '1' || localStorage.getItem('sim') === 'true'
    } catch {
      return false
    }
  }
  return false
}

function showBridgeUnavailableNotice(): () => void {
  const mount = typeof document !== 'undefined' ? document.getElementById('app') : null
  if (!mount) {
    return () => {}
  }
  const notice = document.createElement('div')
  notice.className = 'glasses-bridge-unavailable'
  notice.textContent = 'Glasses bridge unavailable — waiting to reconnect…'
  mount.appendChild(notice)
  return () => notice.remove()
}

export type DetectGlassesBridgeOptions = {
  /** Injection point for tests; defaults to isSimulatorFallbackAllowed(). */
  isSimulatorFallbackAllowed?: () => boolean
}

export async function detectGlassesBridge(
  options: DetectGlassesBridgeOptions = {}
): Promise<GlassesBridge> {
  const allowSimulatorFallback = options.isSimulatorFallbackAllowed ?? isSimulatorFallbackAllowed
  const real = connectEvenHubBridge().catch(() => null)
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), BRIDGE_DETECT_TIMEOUT_MS)
  )
  const winner = await Promise.race([real, timeout])
  if (winner) {
    return winner
  }
  if (allowSimulatorFallback()) {
    return fallbackToMockBridge()
  }
  // Real-device path (finding #7): a slow bridge is not proof it's absent — never silently
  // substitute the simulator. Show a recoverable notice and keep waiting for the real bridge.
  const dismissNotice = showBridgeUnavailableNotice()
  const bridge = await real
  if (bridge) {
    dismissNotice()
    return bridge
  }
  // connectEvenHubBridge() ultimately resolved null — there is truly no bridge on this device.
  // Leave the notice up rather than blanking the page, and let the caller decide how to react
  // to total bridge absence (only reachable on real hardware; simulator fallback wasn't allowed).
  throw new Error('Glasses bridge unavailable')
}
