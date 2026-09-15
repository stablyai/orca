// Integration (Unit 8, spec S9): root double-tap opens the mock exit dialog; "No" resumes
// polling (no teardown); "Yes" tears down the session and closes the client socket.
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

async function bootConnectedShell() {
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

  return { bridge, server, shell }
}

describe('exit flow integration', () => {
  it('resumes polling when the mock exit dialog is dismissed with "No"', async () => {
    const { bridge, shell } = await bootConnectedShell()

    bridge.simulateDoubleClick() // root double-tap: shutDownPage(1) -> mock exit dialog
    await vi.waitFor(() => {
      if (!bridge.isExitDialogOpen()) {
        throw new Error('exit dialog not open yet')
      }
    })

    bridge.emitRaw({ source: 'sys', eventType: 0 }) // CLICK on the default "No" selection
    await vi.waitFor(() => {
      if (bridge.isExitDialogOpen()) {
        throw new Error('exit dialog should have closed')
      }
    })

    // HIGH finding hud-navigation.ts:264: firmware genuinely clears the page behind the exit
    // dialog and does NOT restore it on cancel — the mock must reproduce that blanking rather
    // than silently bringing the dashboard back, or a real "stuck blank HUD" regression would be
    // invisible here. (Cluster D's FOREGROUND_ENTER handler is responsible for forcing the
    // rebuild that un-blanks the HUD; this integration test only pins the mock's honesty.)
    expect(bridge.pageSnapshot()).toBeNull()

    expect(shell.sessions.current()?.client.getState()).toBe('connected')

    // integrator: once hud-navigation.ts's armed FOREGROUND_ENTER path forces a render-queue
    // rebuild (not just a refreshDashboard request) instead of relying on the differ to notice a
    // content change, the dashboard should reappear here. Left failing intentionally until that
    // lands — do not silently loosen this into a no-op assertion.
    await vi.waitFor(
      () => {
        const page = bridge.pageSnapshot()
        if (!page || !textContent(page.containers, 2).includes('api-refactor')) {
          throw new Error('dashboard did not rebuild after the exit dialog cleared the page')
        }
      },
      { timeout: 1000 }
    )

    shell.stop()
  })

  it('tears down the session and closes the socket when the mock exit dialog confirms "Yes"', async () => {
    const { bridge, shell } = await bootConnectedShell()
    const client = shell.sessions.current()!.client

    bridge.simulateDoubleClick()
    await vi.waitFor(() => {
      if (!bridge.isExitDialogOpen()) {
        throw new Error('exit dialog not open yet')
      }
    })

    bridge.simulateScroll('bottom') // toggle selection from "No" to "Yes"
    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      if (!textContent(page.containers, 2).startsWith('  No')) {
        throw new Error('selection has not toggled to Yes yet')
      }
    })

    bridge.emitRaw({ source: 'sys', eventType: 0 }) // CLICK confirms "Yes"
    await vi.waitFor(() => {
      if (bridge.isExitDialogOpen()) {
        throw new Error('exit dialog should have closed')
      }
    })

    // systemExit's teardown effects pause polling; the socket itself is only actually closed
    // once HostSessionManager tears the session down — assert the client the shell was holding
    // reaches 'disconnected' (OrcaSocketClient.close() latches state synchronously).
    expect(client.getState()).toBe('disconnected')

    shell.stop()
  })
})
