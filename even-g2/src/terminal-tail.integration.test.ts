// Integration (Unit 8, spec S9): opening a terminal tail resolves the worktree's agent terminal,
// subscribes over the real transport, and the host's snapshot frames land as paginated text on
// the glasses canvas; scrolling turns pages.
import { describe, it, vi } from 'vitest'
import { startAppShell } from './app/app-shell'
import { MockGlassesBridge } from './sim/mock-glasses-bridge'
import { MockOrcaServer } from './sim/mock-orca-server'
import { createMemorySocketPair } from './sim/memory-socket-pair'
import { toWebSocketLike } from './sim/memory-socket-web-socket-adapter'
import { HostProfileStore } from './transport/host-profile-store'
import type { WebSocketLike } from './transport/orca-socket-client'
import type { HudContainerSpec } from './glasses/glasses-bridge'

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

describe('terminal tail integration', () => {
  it('streams snapshot/output frames as paginated text and turns pages on scroll', async () => {
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

    // Dashboard fits on one page (2 rows), so click drills straight into wt-1's terminal tail
    // (reduceDashboardClick's single-page branch — the cursor starts on row 0, api-refactor).
    bridge.simulateClick()

    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      const header = textContent(page.containers, 1)
      const body = textContent(page.containers, 2)
      if (!header.startsWith('term ·') || !body.includes('All tests passed')) {
        throw new Error('terminal tail scrollback not shown yet')
      }
    })

    // Push enough output that the tail overflows one page (paginateHudBody: 9 lines/400 chars).
    for (let i = 0; i < 20; i++) {
      server.pushTerminalOutputForTest('term-wt1-1', `line ${i}\n`)
    }

    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      const header = textContent(page.containers, 1)
      if (!/term · .* · 1\/[2-9]/.test(header)) {
        throw new Error('terminal tail has not paginated yet')
      }
    })

    const beforeScroll = textContent(bridge.pageSnapshot()!.containers, 2)
    bridge.simulateScroll('bottom')
    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      const header = textContent(page.containers, 1)
      const body = textContent(page.containers, 2)
      if (!header.includes('2/') || body === beforeScroll) {
        throw new Error('scroll has not turned the page yet')
      }
    })

    shell.stop()
  })
})
