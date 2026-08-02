import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import { useHostStatusGates, type HostStatusGates } from './host-status-gates'

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => spy.mockRestore()
}

describe('useHostStatusGates', () => {
  it('clears every prior-host gate and ignores its late response while the client is replaced', async () => {
    let resolveOldStatus: ((response: unknown) => void) | null = null
    const pendingOldStatus = new Promise((resolve) => {
      resolveOldStatus = resolve
    })
    const oldSendRequest = vi.fn().mockReturnValue(pendingOldStatus)
    const oldClient = { sendRequest: oldSendRequest } as unknown as RpcClient
    const newSendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        capabilities: ['terminal.quick-commands.v1'],
        floatingWorkspaceEnabled: true
      }
    })
    const newClient = { sendRequest: newSendRequest } as unknown as RpcClient
    let gates: HostStatusGates | null = null
    const firstRenderByHost = new Map<string, HostStatusGates>()
    let renderer: ReactTestRenderer | null = null

    function Probe({ hostId, client }: { hostId: string; client: RpcClient }): null {
      gates = useHostStatusGates({ hostId, client, connState: 'connected' })
      if (!firstRenderByHost.has(hostId)) {
        firstRenderByHost.set(hostId, gates)
      }
      return null
    }

    const restore = suppressReactTestRendererDeprecationWarning()
    try {
      await act(async () => {
        renderer = create(createElement(Probe, { hostId: 'host-1', client: oldClient }))
      })

      await act(async () => {
        renderer?.update(createElement(Probe, { hostId: 'host-2', client: newClient }))
        await Promise.resolve()
      })
      expect(firstRenderByHost.get('host-2')).toMatchObject({
        hostCapabilities: [],
        floatingWorkspaceEnabled: false,
        compatVerdict: { kind: 'ok' }
      })
      expect(gates).toMatchObject({
        hostCapabilities: ['terminal.quick-commands.v1'],
        floatingWorkspaceEnabled: true
      })

      await act(async () => {
        resolveOldStatus?.({
          ok: true,
          result: {
            capabilities: ['browser.screencast.v1'],
            floatingWorkspaceEnabled: true
          }
        })
        await pendingOldStatus
      })
      expect(gates).toMatchObject({
        hostCapabilities: ['terminal.quick-commands.v1'],
        floatingWorkspaceEnabled: true
      })
      expect(oldSendRequest).toHaveBeenCalledOnce()
      expect(newSendRequest).toHaveBeenCalledOnce()
    } finally {
      restore()
      renderer?.unmount()
    }
  })

  it('loads gates from the connected host', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        capabilities: ['browser.screencast.v1'],
        floatingWorkspaceEnabled: true
      }
    })
    const client = { sendRequest } as unknown as RpcClient
    let gates: HostStatusGates | null = null
    let renderer: ReactTestRenderer | null = null

    function Probe({ hostId }: { hostId: string }): null {
      gates = useHostStatusGates({ hostId, client, connState: 'connected' })
      return null
    }

    const restore = suppressReactTestRendererDeprecationWarning()
    try {
      await act(async () => {
        renderer = create(createElement(Probe, { hostId: 'host-1' }))
        await Promise.resolve()
      })
      expect(gates).toMatchObject({
        hostCapabilities: ['browser.screencast.v1'],
        floatingWorkspaceEnabled: true
      })

      expect(sendRequest).toHaveBeenCalledOnce()
    } finally {
      restore()
      renderer?.unmount()
    }
  })

  it('fails closed while the same client reconnects', async () => {
    let resolveReconnect: ((response: unknown) => void) | null = null
    const pendingReconnect = new Promise((resolve) => {
      resolveReconnect = resolve
    })
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { capabilities: ['browser.screencast.v1'], floatingWorkspaceEnabled: true }
      })
      .mockReturnValueOnce(pendingReconnect)
    const client = { sendRequest } as unknown as RpcClient
    let gates: HostStatusGates | null = null
    let renderer: ReactTestRenderer | null = null

    function Probe({ connState }: { connState: 'connected' | 'disconnected' }): null {
      gates = useHostStatusGates({ hostId: 'host-1', client, connState })
      return null
    }

    const restore = suppressReactTestRendererDeprecationWarning()
    try {
      await act(async () => {
        renderer = create(createElement(Probe, { connState: 'connected' }))
        await Promise.resolve()
      })
      expect(gates?.floatingWorkspaceEnabled).toBe(true)

      await act(async () => {
        renderer?.update(createElement(Probe, { connState: 'disconnected' }))
      })
      await act(async () => {
        renderer?.update(createElement(Probe, { connState: 'connected' }))
      })
      expect(gates).toMatchObject({
        hostCapabilities: [],
        floatingWorkspaceEnabled: false
      })

      await act(async () => {
        resolveReconnect?.({
          ok: true,
          result: { capabilities: ['terminal.quick-commands.v1'], floatingWorkspaceEnabled: true }
        })
        await pendingReconnect
      })
      expect(gates).toMatchObject({
        hostCapabilities: ['terminal.quick-commands.v1'],
        floatingWorkspaceEnabled: true
      })
    } finally {
      restore()
      renderer?.unmount()
    }
  })
})
