// Integrator wiring (Unit 8, spec S4/S10 step 1): races the real EvenHub bridge against a
// 1500ms timeout. On timeout in a plain browser (dev, or hardware not present), falls back to
// MockGlassesBridge + the canvas preview via a dynamic import, so the prod bundle never carries
// simulator code but a plain-browser open still works.
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

export async function detectGlassesBridge(): Promise<GlassesBridge> {
  const real = connectEvenHubBridge().catch(() => null)
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), BRIDGE_DETECT_TIMEOUT_MS)
  )
  const winner = await Promise.race([real, timeout])
  return winner ?? fallbackToMockBridge()
}
