import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import { HostProtocolAdmission } from './host-protocol-admission'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import { attachHostProtocolVerification } from './host-protocol-verifier'
import { useHostStatusGates, type HostStatusGates } from './host-status-gates'

const recordHostAppVersionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('./host-app-version-store', () => ({
  normalizeHostAppVersion: (value: unknown) => (typeof value === 'string' ? value : null),
  recordHostAppVersion: (...args: unknown[]) => recordHostAppVersionMock(...args)
}))

function verifiedClient(session: FakeSession, hostId: string): RpcClient {
  return attachHostProtocolVerification(
    createStableLogicalRpcClient(session, 'lan', new HostProtocolAdmission()),
    hostId
  )
}

function answering(result: unknown): FakeSession {
  const session = new FakeSession('connected')
  session.sendRequest.mockResolvedValue({ id: '1', ok: true, result })
  return session
}

describe('useHostStatusGates', () => {
  it('clears every prior-host gate and ignores its late response while the client is replaced', async () => {
    const oldSession = new FakeSession('connected')
    let resolveOldStatus: ((response: unknown) => void) | null = null
    const pendingOldStatus = new Promise((resolve) => {
      resolveOldStatus = resolve
    })
    oldSession.sendRequest.mockReturnValue(pendingOldStatus as Promise<never>)
    const oldClient = verifiedClient(oldSession, 'host-1')
    const newSession = new FakeSession('connected')
    let resolveNewStatus: ((response: unknown) => void) | null = null
    const pendingNewStatus = new Promise((resolve) => {
      resolveNewStatus = resolve
    })
    newSession.sendRequest.mockReturnValue(pendingNewStatus as Promise<never>)
    const newClient = verifiedClient(newSession, 'host-2')
    let gates: HostStatusGates | null = null
    const firstRenderByHost = new Map<string, HostStatusGates>()
    let renderer: ReactTestRenderer | null = null

    function Probe({ hostId, client }: { hostId: string; client: RpcClient }): null {
      gates = useHostStatusGates({ client, connState: 'connected' })
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
      // Nothing host-1 proved may show up on the replacement's first render.
      expect(firstRenderByHost.get('host-2')).toMatchObject({
        hostCapabilities: [],
        floatingWorkspaceEnabled: false,
        compatVerdict: { kind: 'unknown' }
      })

      await act(async () => {
        resolveNewStatus?.({
          id: '3',
          ok: true,
          result: {
            protocolVersion: 3,
            minCompatibleMobileVersion: 3,
            capabilities: ['terminal.quick-commands.v1'],
            floatingWorkspaceEnabled: true
          }
        })
        await pendingNewStatus
      })
      expect(gates).toMatchObject({
        hostCapabilities: ['terminal.quick-commands.v1'],
        floatingWorkspaceEnabled: true
      })

      await act(async () => {
        resolveOldStatus?.({
          id: '2',
          ok: true,
          result: {
            protocolVersion: 3,
            minCompatibleMobileVersion: 3,
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
      expect(oldSession.sendRequest).toHaveBeenCalledOnce()
      expect(newSession.sendRequest).toHaveBeenCalledOnce()
    } finally {
      renderer?.unmount()
      oldClient.close()
      newClient.close()
    }
  })

  it('loads gates from the connected host', async () => {
    const session = answering({
      protocolVersion: 3,
      minCompatibleMobileVersion: 3,
      appVersion: '1.4.191',
      capabilities: ['browser.screencast.v1'],
      floatingWorkspaceEnabled: true
    })
    const client = verifiedClient(session, 'host-1')
    let gates: HostStatusGates | null = null
    let renderer: ReactTestRenderer | null = null

    function Probe(): null {
      gates = useHostStatusGates({ client, connState: 'connected' })
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(Probe))
        await Promise.resolve()
      })
      expect(gates).toMatchObject({
        desktopAppVersion: '1.4.191',
        hostCapabilities: ['browser.screencast.v1'],
        floatingWorkspaceEnabled: true
      })

      expect(session.sendRequest).toHaveBeenCalledOnce()
      expect(recordHostAppVersionMock).toHaveBeenCalledWith('host-1', '1.4.191')
    } finally {
      renderer?.unmount()
      client.close()
    }
  })

  it('keeps the proven gates while the same client reconnects, pending until it re-answers', async () => {
    const session = answering({
      protocolVersion: 3,
      minCompatibleMobileVersion: 3,
      capabilities: ['browser.screencast.v1'],
      floatingWorkspaceEnabled: true
    })
    const client = verifiedClient(session, 'host-1')
    let gates: HostStatusGates | null = null
    let renderer: ReactTestRenderer | null = null

    function Probe({ connState }: { connState: 'connected' | 'disconnected' }): null {
      gates = useHostStatusGates({ client, connState })
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(Probe, { connState: 'connected' }))
        await Promise.resolve()
      })
      expect(gates?.floatingWorkspaceEnabled).toBe(true)

      let resolveReconnect: ((response: unknown) => void) | null = null
      const pendingReconnect = new Promise((resolve) => {
        resolveReconnect = resolve
      })
      session.sendRequest.mockReturnValue(pendingReconnect as Promise<never>)
      await act(async () => {
        session.publishState('disconnected')
        renderer?.update(createElement(Probe, { connState: 'disconnected' }))
      })
      // Why (F10): the drop invalidates nothing the host already proved — capabilities survive it.
      expect(gates).toMatchObject({
        hostCapabilities: ['browser.screencast.v1'],
        floatingWorkspaceEnabled: true,
        statusPending: false
      })

      await act(async () => {
        session.publishState('connected')
        renderer?.update(createElement(Probe, { connState: 'connected' }))
      })
      expect(gates).toMatchObject({
        hostCapabilities: ['browser.screencast.v1'],
        floatingWorkspaceEnabled: true,
        statusPending: true
      })

      await act(async () => {
        resolveReconnect?.({
          id: '2',
          ok: true,
          result: {
            protocolVersion: 3,
            minCompatibleMobileVersion: 3,
            capabilities: ['terminal.quick-commands.v1'],
            floatingWorkspaceEnabled: true
          }
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
      client.close()
    }
  })

  it('fails closed when the same host reconnects on a replaced client', async () => {
    const firstSession = answering({
      protocolVersion: 3,
      minCompatibleMobileVersion: 3,
      capabilities: ['browser.screencast.v1']
    })
    const firstClient = verifiedClient(firstSession, 'host-1')
    const secondSession = new FakeSession('connected')
    secondSession.sendRequest.mockReturnValue(new Promise(() => {}) as Promise<never>)
    const secondClient = verifiedClient(secondSession, 'host-1')
    let gates: HostStatusGates | null = null
    let renderer: ReactTestRenderer | null = null

    function Probe({ client }: { client: RpcClient }): null {
      gates = useHostStatusGates({ client, connState: 'connected' })
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
      firstClient.close()
      secondClient.close()
    }
  })
})
