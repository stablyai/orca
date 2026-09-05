// Integration (Unit 8, spec S9): permission notification -> header nudge -> click into ask
// screen -> scroll+click option 1 -> the mock host actually receives terminal.send("1\r") ->
// status leaves permission -> footer confirms. Exercises HudInputRouter, the nav reducer, the
// ask quick-action encoding, and the real RPC round trip together.
import { describe, it, vi } from 'vitest'
import { startAppShell } from './app/app-shell'
import { MockGlassesBridge } from './sim/mock-glasses-bridge'
import { MockOrcaServer } from './sim/mock-orca-server'
import { createMemorySocketPair } from './sim/memory-socket-pair'
import { toWebSocketLike } from './sim/memory-socket-web-socket-adapter'
import { HostProfileStore } from './transport/host-profile-store'
import type { WebSocketLike } from './transport/orca-socket-client'
import type { HudContainerSpec } from './glasses/glasses-bridge'

const OS_EVENT_FOREGROUND_ENTER = 4

// WorktreeDashboardController only polls every 5s on its own; a foregroundEnter event is the
// real (non-test-only) way the app forces an immediate poll (spec S8's push-nudge / nav-ports'
// resumePolling), so tests use it instead of waiting out the natural interval.
function forceRefresh(bridge: MockGlassesBridge): void {
  bridge.emitRaw({ source: 'sys', eventType: OS_EVENT_FOREGROUND_ENTER })
}

function socketFactoryFor(server: MockOrcaServer): (url: string) => WebSocketLike {
  return () => {
    const { clientSocket, serverSocket } = createMemorySocketPair()
    server.attach(serverSocket)
    return toWebSocketLike(clientSocket)
  }
}

function textContent(containers: HudContainerSpec[], id: number): string {
  const container = containers.find((c) => c.id === id)
  return container && container.kind === 'text' ? container.content : ''
}

describe('ask flow integration', () => {
  it('answers a permission ask via ring scroll+click and confirms once the host clears it', async () => {
    const bridge = new MockGlassesBridge()
    const server = new MockOrcaServer()
    const hostProfileStore = new HostProfileStore(bridge)
    await hostProfileStore.upsert({
      id: 'host-1',
      name: 'Dev machine',
      endpoint: 'memory://host-1',
      deviceToken: 'mock-device-token',
      publicKeyB64: server.publicKeyB64,
      lastConnected: Date.now()
    })

    const sentRequests: { method: string; params?: Record<string, unknown> }[] = []
    server.onRequestForTest = (method, params) => sentRequests.push({ method, params })

    const shell = await startAppShell({
      bridge,
      hostProfileStore,
      socketFactory: socketFactoryFor(server)
    })

    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()
      if (!page || !textContent(page.containers, 2).includes('api-refactor')) {
        throw new Error('dashboard not rendered yet')
      }
    })

    // The worktree flips to `permission` first so the notification resolves to kind: 'ask'
    // (spec S8's ask-kind derivation reads the worktree's current status).
    server.setWorktreeStatus('wt-1', 'permission')
    forceRefresh(bridge)
    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      if (!textContent(page.containers, 2).includes('▲')) {
        throw new Error('dashboard has not picked up the permission status yet')
      }
    })

    server.pushNotification({
      type: 'notification',
      source: 'claude',
      title: 'Needs input',
      body: 'Approve write? [1] Yes [2] No',
      worktreeId: 'wt-1',
      notificationId: 'notif-ask-1'
    })

    // Header nudge upgrade (spec S8): line 1 swaps to a click-through prompt.
    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      if (!textContent(page.containers, 1).includes('needs input')) {
        throw new Error('header nudge not shown yet')
      }
    })

    bridge.simulateClick() // jumps into the ask screen (reduceClick's pending-ask priority)
    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      if (!textContent(page.containers, 1).includes('Needs input')) {
        throw new Error('ask screen not shown yet')
      }
    })

    // Exercise the scroll cursor (option 1 -> 2 -> back to 1), spacing calls past the
    // normalizer's 300ms scroll cooldown so neither move is dropped as a storm.
    bridge.simulateScroll('bottom')
    await new Promise((resolve) => setTimeout(resolve, 350))
    bridge.simulateScroll('top')
    await new Promise((resolve) => setTimeout(resolve, 350))
    bridge.simulateClick() // sends option 1

    await vi.waitFor(() => {
      const sent = sentRequests.find((r) => r.method === 'terminal.send')
      if (!sent || sent.params?.text !== '1\r') {
        throw new Error('terminal.send("1\\r") not observed yet')
      }
    })

    server.setWorktreeStatus('wt-1', 'active')
    forceRefresh(bridge)
    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      if (!textContent(page.containers, 3).includes('answered')) {
        throw new Error('footer has not confirmed yet')
      }
    })

    shell.stop()
  })
})
