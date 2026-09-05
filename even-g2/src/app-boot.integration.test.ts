// Integration (Unit 8, spec S9): MockGlassesBridge + MockOrcaServer + memory-socket-pair, real
// everything else. Boots with a saved profile and asserts the dashboard actually lands on the
// glasses canvas — the whole transport/state/nav/render pipeline, not a single unit.
import { describe, expect, it, vi } from 'vitest'
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

describe('app boot integration', () => {
  it('boots with a saved profile, connects over the mock transport, and renders the dashboard', async () => {
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

    const page = bridge.pageSnapshot()!
    const header = textContent(page.containers, 1)
    const body = textContent(page.containers, 2)

    // Header counts (spec S8): fixture has 1 working worktree (wt-1) and 0 waiting-on-permission.
    expect(header).toContain('Orca ·')
    expect(header).toContain('1 running')
    expect(header).toContain('0 waiting')

    // Body rows: status glyph + worktree name (spec S5 dashboard-screen).
    expect(body).toContain('▶')
    expect(body).toContain('api-refactor')
    expect(body).toContain('hotfix-login')

    shell.stop()
  })
})
