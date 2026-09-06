import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { useWebHostStatusGates } from './web-host-status-gates'
import type { HostStatusGates } from './host-status-gates'

describe('useWebHostStatusGates', () => {
  it('loads the exact bounded projection from a current shell', async () => {
    const client = clientWithResult({
      hostCapabilities: ['aiVault.v1'],
      floatingWorkspaceEnabled: true
    })
    const gates = await renderConnected(client)

    expect(gates.current).toMatchObject({
      hostCapabilities: ['aiVault.v1'],
      floatingWorkspaceEnabled: true,
      statusPending: false
    })
  })

  it('degrades safely when an older shell rejects the flagged payload', async () => {
    const client = {
      sessionHostGates: vi.fn().mockRejectedValue({ code: 'invalid_request' })
    } as unknown as MobileWebBridgeClient
    const gates = await renderConnected(client)

    expect(gates.current).toMatchObject({
      hostCapabilities: [],
      floatingWorkspaceEnabled: false,
      compatVerdict: { kind: 'ok' },
      statusPending: false
    })
  })

  it('retains proven gates across reconnect and clears them for a new client', async () => {
    let rejectRefresh: ((reason: unknown) => void) | null = null
    const refresh = new Promise((_, reject) => {
      rejectRefresh = reject
    })
    const firstClient = {
      sessionHostGates: vi
        .fn()
        .mockResolvedValueOnce({
          hostCapabilities: ['aiVault.v1'],
          floatingWorkspaceEnabled: true
        })
        .mockReturnValueOnce(refresh)
    } as unknown as MobileWebBridgeClient
    const secondClient = {
      sessionHostGates: vi.fn().mockReturnValue(new Promise(() => {}))
    } as unknown as MobileWebBridgeClient
    let current: HostStatusGates | null = null
    let renderer: ReactTestRenderer | null = null

    function Probe({
      client,
      connection
    }: {
      client: MobileWebBridgeClient
      connection: 'connected' | 'offline'
    }): null {
      current = useWebHostStatusGates({ client, connection })
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(Probe, { client: firstClient, connection: 'connected' }))
        await Promise.resolve()
      })
      await act(async () => {
        renderer?.update(createElement(Probe, { client: firstClient, connection: 'offline' }))
      })
      expect(current).toMatchObject({ hostCapabilities: ['aiVault.v1'], statusPending: false })

      await act(async () => {
        renderer?.update(createElement(Probe, { client: firstClient, connection: 'connected' }))
      })
      expect(current).toMatchObject({ hostCapabilities: ['aiVault.v1'], statusPending: true })
      await act(async () => {
        rejectRefresh?.({ code: 'not_connected' })
        await refresh.catch(() => undefined)
      })
      expect(current).toMatchObject({ hostCapabilities: ['aiVault.v1'], statusPending: false })

      await act(async () => {
        renderer?.update(createElement(Probe, { client: secondClient, connection: 'connected' }))
      })
      expect(current).toMatchObject({ hostCapabilities: [], statusPending: true })
    } finally {
      renderer?.unmount()
    }
  })
})

function clientWithResult(result: {
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
}): MobileWebBridgeClient {
  return {
    sessionHostGates: vi.fn().mockResolvedValue(result)
  } as unknown as MobileWebBridgeClient
}

async function renderConnected(client: MobileWebBridgeClient): Promise<{
  current: HostStatusGates | null
}> {
  const gates: { current: HostStatusGates | null } = { current: null }
  let renderer: ReactTestRenderer | null = null
  function Probe(): null {
    gates.current = useWebHostStatusGates({ client, connection: 'connected' })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe))
    await Promise.resolve()
  })
  renderer?.unmount()
  return gates
}
