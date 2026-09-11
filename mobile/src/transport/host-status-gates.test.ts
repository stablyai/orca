import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import { useHostStatusGates, type HostStatusGates } from './host-status-gates'

const recordHostAppVersionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('./host-app-version-store', () => ({
  normalizeHostAppVersion: (value: unknown) => (typeof value === 'string' ? value : null),
  recordHostAppVersion: (...args: unknown[]) => recordHostAppVersionMock(...args)
}))

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
      renderer?.unmount()
    }
  })

  it('loads gates from the connected host', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        appVersion: '1.4.191',
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

    try {
      await act(async () => {
        renderer = create(createElement(Probe, { hostId: 'host-1' }))
        await Promise.resolve()
      })
      expect(gates).toMatchObject({
        desktopAppVersion: '1.4.191',
        hostCapabilities: ['browser.screencast.v1'],
        floatingWorkspaceEnabled: true
      })

      expect(sendRequest).toHaveBeenCalledOnce()
      expect(recordHostAppVersionMock).toHaveBeenCalledWith('host-1', '1.4.191')
    } finally {
      renderer?.unmount()
    }
  })

  it('keeps the proven gates while the same client reconnects, pending until it re-answers', async () => {
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

    try {
      await act(async () => {
        renderer = create(createElement(Probe, { connState: 'connected' }))
        await Promise.resolve()
      })
      expect(gates?.floatingWorkspaceEnabled).toBe(true)

      await act(async () => {
        renderer?.update(createElement(Probe, { connState: 'disconnected' }))
      })
      // Why (F10): the drop invalidates nothing the host already proved — capabilities survive it.
      expect(gates).toMatchObject({
        hostCapabilities: ['browser.screencast.v1'],
        floatingWorkspaceEnabled: true,
        statusPending: false
      })

      await act(async () => {
        renderer?.update(createElement(Probe, { connState: 'connected' }))
      })
      expect(gates).toMatchObject({
        hostCapabilities: ['browser.screencast.v1'],
        floatingWorkspaceEnabled: true,
        statusPending: true
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
        floatingWorkspaceEnabled: true,
        statusPending: false
      })
    } finally {
      renderer?.unmount()
    }
  })

  it('fails closed when the same host reconnects on a replaced client', async () => {
    const firstClient = {
      sendRequest: vi.fn().mockResolvedValue({
        ok: true,
        result: { capabilities: ['browser.screencast.v1'], floatingWorkspaceEnabled: true }
      })
    } as unknown as RpcClient
    const secondClient = {
      sendRequest: vi.fn().mockReturnValue(new Promise(() => {}))
    } as unknown as RpcClient
    let gates: HostStatusGates | null = null
    let renderer: ReactTestRenderer | null = null

    function Probe({ client }: { client: RpcClient }): null {
      gates = useHostStatusGates({ hostId: 'host-1', client, connState: 'connected' })
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(Probe, { client: firstClient }))
        await Promise.resolve()
      })
      expect(gates?.hostCapabilities).toEqual(['browser.screencast.v1'])

      await act(async () => {
        renderer?.update(createElement(Probe, { client: secondClient }))
      })
      expect(gates).toMatchObject({ hostCapabilities: [], statusPending: true })
    } finally {
      renderer?.unmount()
    }
  })
})
