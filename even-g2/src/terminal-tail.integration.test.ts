// Integration (Unit 8, spec S9): opening a terminal tail resolves the worktree's agent terminal,
// subscribes over the real transport, and the host's snapshot frames land as paginated text on
// the glasses canvas; scrolling turns pages.
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

    // CRITICAL finding terminal-tail-state.ts:42: the client must negotiate the binary stream
    // capability — a host that doesn't see it publishes JSON events the decoder can't render.
    const subscribe = sentRequests.find((r) => r.method === 'terminal.subscribe')
    if (
      (subscribe?.params?.capabilities as { terminalBinaryStream?: number } | undefined)
        ?.terminalBinaryStream !== 1
    ) {
      throw new Error('terminal.subscribe did not request capabilities.terminalBinaryStream: 1')
    }
    // resolveViewableTerminalHandle (finding #1: terminal.resolveActive is not on the mobile
    // allowlist) picks whichever of wt-1's terminals has an agentIdentity and the newest
    // lastOutputAt — read back which one it actually opened rather than assume term-wt1-1.
    const openedTerminalId = subscribe!.params!.terminal as string
    // HIGH finding terminal-tail-decoder.ts:65: SnapshotStart carries JSON metadata
    // (kind/cols/rows/...), never terminal text — it must never leak into the rendered tail.
    const firstBody = textContent(bridge.pageSnapshot()!.containers, 2)
    if (firstBody.includes('"kind"') || firstBody.includes('"cols"')) {
      throw new Error('SnapshotStart metadata leaked into the rendered terminal tail')
    }

    // Push enough output that the tail overflows one page (paginateHudBody: 9 lines/400 chars).
    for (let i = 0; i < 20; i++) {
      server.pushTerminalOutputForTest(openedTerminalId, `line ${i}\n`)
    }

    // Finding #8: `frame.page` is an offset from the LATEST page (0 = latest), and the wearer
    // stays on the live edge until they scroll — so once this overflows to multiple pages, the
    // default view must show the newest output (the last page), not page 1 of N.
    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      const header = textContent(page.containers, 1)
      const match = /term · .* · (\d+)\/(\d+)/.exec(header)
      if (!match || match[2] === '1' || match[1] !== match[2]) {
        throw new Error('terminal tail has not paginated to the latest page yet')
      }
    })

    const latestHeader = textContent(bridge.pageSnapshot()!.containers, 1)
    const latestBody = textContent(bridge.pageSnapshot()!.containers, 2)
    const [, latestIndex, pageCount] = /term · .* · (\d+)\/(\d+)/.exec(latestHeader)!
    expect(latestBody).toContain('line 19')
    expect(latestBody).not.toContain('All tests passed.')

    // scrollNext (SCROLL_BOTTOM) moves further into history: the offset from latest increases,
    // so the displayed page index goes DOWN (finding #8's offset-from-latest semantics).
    bridge.simulateScroll('bottom')
    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      const header = textContent(page.containers, 1)
      const body = textContent(page.containers, 2)
      if (!header.includes(`${Number(latestIndex) - 1}/${pageCount}`) || body === latestBody) {
        throw new Error('scroll has not turned the page back into history yet')
      }
    })
    const historyBody = textContent(bridge.pageSnapshot()!.containers, 2)
    expect(historyBody).not.toContain('line 19')

    // A click resets the tail back to the latest page (finding #8's "click=latest").
    bridge.simulateClick()
    await vi.waitFor(() => {
      const page = bridge.pageSnapshot()!
      const header = textContent(page.containers, 1)
      const body = textContent(page.containers, 2)
      if (!header.includes(`${pageCount}/${pageCount}`) || !body.includes('line 19')) {
        throw new Error('click has not reset to the latest page yet')
      }
    })

    shell.stop()
  })
})
