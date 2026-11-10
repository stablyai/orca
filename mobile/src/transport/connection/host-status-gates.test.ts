import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../rpc/rpc-client-contract'
import { useHostStatusGates, type HostStatusGates } from './host-status-gates'

const recordHostAppVersionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('../../host-descriptors/host-app-version-store', () => ({
  recordHostAppVersion: (...args: unknown[]) => recordHostAppVersionMock(...args)
}))

const recordDescriptorFromStatusMock = vi.hoisted(() => vi.fn())

vi.mock('../../host-descriptors/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: (...args: unknown[]) => recordDescriptorFromStatusMock(...args)
}))

describe('useHostStatusGates', () => {
  beforeEach(() => {
    recordDescriptorFromStatusMock.mockClear()
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
    let gates: HostStatusGates | undefined
    let renderer: ReactTestRenderer | undefined

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
