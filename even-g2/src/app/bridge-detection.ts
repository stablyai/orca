// Integrator wiring (Unit 8, spec S4/S10 step 1): races the real EvenHub bridge against a
// 1500ms timeout. On timeout, falls back to MockGlassesBridge + the canvas preview via a
// dynamic import (so the prod bundle never carries simulator code) — but only when a
// dev/plain-browser signal says this isn't a real device (finding #7 of the critical review): a
// slow-but-present bridge on real hardware is not evidence it's absent, and silently swapping in
// the simulator there would show a fake HUD on real glasses. On a real device we keep waiting
// for the real bridge instead, surfacing a recoverable notice in the meantime.
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

/** True when it's safe to substitute the canvas simulator for a missing/slow bridge: a Vite
 *  dev server build, or an explicit `?sim` opt-in (e.g. testing index.html directly). Never
 *  true in a plain production build with no explicit opt-in. */
export function isSimulatorFallbackAllowed(): boolean {
  // Cast rather than declaring vite/client's ambient ImportMeta.env type (this project's
  // tsconfig `types` is scoped to vitest/globals only) — Vite always injects import.meta.env
  // at build/dev time regardless of TS's static view of it.
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env
  if (env?.DEV) {
    return true
  }
  if (typeof location !== 'undefined') {
    try {
      return new URLSearchParams(location.search).has('sim')
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
