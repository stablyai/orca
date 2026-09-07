// Unit 6/8: boots the REAL app shell (state/nav/screens/render-queue — the exact production
// code path, spec S3) against MockGlassesBridge (canvas) + MockOrcaServer over a
// memory-socket-pair (spec S9), so `pnpm sim` shows the actual app rather than a demo driver.
import { startAppShell } from '../app/app-shell'
import { HostProfileStore } from '../transport/host-profile-store'
import type { WebSocketLike } from '../transport/orca-socket-client'
import type { GlassesCanvasPreview } from './glasses-canvas-preview'
import { createGlassesCanvasPreview } from './glasses-canvas-preview'
import { MockGlassesBridge } from './mock-glasses-bridge'
import { createMemorySocketPair } from './memory-socket-pair'
import { toWebSocketLike } from './memory-socket-web-socket-adapter'
import { MockOrcaServer } from './mock-orca-server'

/** Duck-typed to just the two bridge reads the repaint hook needs, so this stays testable
 *  without constructing a full MockGlassesBridge. */
export type RepaintSource = {
  pageSnapshot: MockGlassesBridge['pageSnapshot']
  getListSelection: MockGlassesBridge['getListSelection']
}

/** Repaints the preview from the bridge's current page, or blanks it when there's no HUD page
 *  (e.g. after a hard shutdown / confirmed exit) so the sim doesn't keep showing a stale frame. */
export function renderPreviewFrame(
  bridge: RepaintSource,
  preview: GlassesCanvasPreview | null
): void {
  const page = bridge.pageSnapshot()
  if (page) {
    preview?.paint(page, { listSelectedIndex: bridge.getListSelection() })
  } else {
    preview?.clear()
  }
}

async function main(): Promise<void> {
  const root = document.getElementById('app')
  if (!root) {
    return
  }
  root.innerHTML = ''

  const canvasMount = document.createElement('div')
  root.appendChild(canvasMount)
  const preview = createGlassesCanvasPreview(canvasMount)

  const bridge = new MockGlassesBridge()
  bridge.setOnRepaint(() => renderPreviewFrame(bridge, preview))
  // flushRenders() is intentionally not auto-triggered by the bridge (tests want full control
  // over repaint timing) — drive it once per frame here for the live sim.
  const tick = (): void => {
    bridge.flushRenders()
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const server = new MockOrcaServer()
  const socketFactory = (_url: string): WebSocketLike => {
    const { clientSocket, serverSocket } = createMemorySocketPair()
    server.attach(serverSocket)
    return toWebSocketLike(clientSocket)
  }

  // Seed one paired host profile pointing at the mock server so the app shell connects
  // straight to the dashboard on boot, mirroring a real single-host session (spec S10).
  const hostProfileStore = new HostProfileStore(bridge)
  await hostProfileStore.upsert({
    id: 'sim-host',
    name: 'Sim host',
    endpoint: 'memory://sim-host',
    deviceToken: 'mock-device-token',
    publicKeyB64: server.publicKeyB64,
    lastConnected: Date.now()
  })

  await startAppShell({ bridge, hostProfileStore, socketFactory })

  const log = document.createElement('pre')
  log.textContent = `mock server public key: ${server.publicKeyB64}`
  root.appendChild(log)

  const buttons = document.createElement('div')
  const addButton = (label: string, onClick: () => void): void => {
    const button = document.createElement('button')
    button.textContent = label
    button.onclick = onClick
    buttons.appendChild(button)
  }
  addButton('push ask', () =>
    server.pushNotification({
      type: 'notification',
      source: 'claude',
      title: 'Needs input',
      body: 'Approve step? [1] Yes [2] No',
      worktreeId: 'wt-1',
      notificationId: 'notif-demo'
    })
  )
  addButton('flip status', () => server.setWorktreeStatus('wt-1', 'permission'))
  addButton('drop connection', () => server.dropConnection())
  addButton('slow rpc', () => {
    server.delayMs = server.delayMs > 0 ? 0 : 2000
    log.textContent = `mock server public key: ${server.publicKeyB64}\nrpc delay: ${server.delayMs}ms`
  })
  root.appendChild(buttons)
}

void main()
