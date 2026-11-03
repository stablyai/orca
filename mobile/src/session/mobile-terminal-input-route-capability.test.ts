import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { TERMINAL_ORDERED_INPUT_CAPABILITY } from '../../../src/shared/terminal-ordered-input'
import { HostStatusGatesContext } from '../components/host-protocol-gates-context'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { HostStatusGates } from '../transport/host-status-gates'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'
import { WorkspaceServerContext } from '../transport/use-workspace-client'
import { useMobileSessionTerminalWebview } from './use-mobile-session-terminal-webview'

vi.mock('../transport/host-client-hooks', () => ({ useHostClient: vi.fn() }))

it.each([
  { server: true, desktop: false, relayed: true, ordered: false },
  { server: false, desktop: true, relayed: true, ordered: false },
  { server: true, desktop: true, relayed: true, ordered: true },
  { server: true, desktop: false, relayed: false, ordered: true }
])('delivers with route capabilities %j', async ({ server, desktop, relayed, ordered }) => {
  const methods: string[] = []
  const releases: ((reply: RpcResponse) => void)[] = []
  const client = stubRpcClient({
    sendRequest: (method) => {
      methods.push(method)
      if (method === 'terminal.openInputSession') {
        return Promise.resolve({ id: 'open', ok: true, result: { inputSessionId: 'session' } })
      }
      return new Promise<RpcResponse>((resolve) => releases.push(resolve))
    }
  })
  const capabilities = server ? [TERMINAL_ORDERED_INPUT_CAPABILITY] : []
  let send!: ReturnType<typeof useMobileSessionTerminalWebview>['sendTerminalUserInput']
  function Probe() {
    send = useMobileSessionTerminalWebview(
      mountFixture({
        client,
        hostCapabilities: capabilities,
        terminalRefs: { current: new Map() },
        terminalPaneViewportsRef: { current: new Map() },
        terminals: [],
        visibleTerminalHandles: [],
        visibleTerminalHandlesRef: { current: [] },
        terminalUnsubsRef: { current: new Map() }
      })
    ).sendTerminalUserInput
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      createElement(
        HostStatusGatesContext.Provider,
        { value: mountFixture<HostStatusGates>({ hostCapabilities: capabilities }) },
        createElement(
          WorkspaceServerContext.Provider,
          {
            value: relayed
              ? { client, state: 'connected', desktopCapabilities: desktop ? capabilities : [] }
              : undefined
          },
          createElement(Probe)
        )
      )
    )
  })
  const accepted: RpcResponse = { id: 'send', ok: true, result: { send: { accepted: true } } }
  try {
    const first = send(client, {
      terminal: 'term',
      text: 'a',
      client: { id: 'phone', type: 'mobile' }
    })
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    const second = send(client, {
      terminal: 'term',
      text: 'b',
      client: { id: 'phone', type: 'mobile' }
    })
    expect(methods.includes('terminal.openInputSession')).toBe(ordered)
    expect(releases).toHaveLength(ordered ? 2 : 1)
    releases.shift()!(accepted)
    await first
    if (!ordered) {
      await vi.waitFor(() => expect(releases).toHaveLength(1))
    }
    releases.shift()!(accepted)
    await expect(second).resolves.toMatchObject({ result: { send: { accepted: true } } })
  } finally {
    act(() => renderer.unmount())
    releases.splice(0).forEach((release) => release(accepted))
  }
})
