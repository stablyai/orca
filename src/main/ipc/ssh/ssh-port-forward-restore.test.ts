import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortForwardEntry, SavedPortForward } from '../../../shared/ssh-types'

const h = vi.hoisted(() => {
  const conn = { id: 'conn' }
  const saved: { portForwards?: SavedPortForward[] } = {}
  const active: PortForwardEntry[] = []
  return {
    conn,
    saved,
    active,
    store: {
      getTarget: vi.fn(() => ({ id: 't1', ...saved })),
      updateTarget: vi.fn((_id: string, update: { portForwards?: SavedPortForward[] }) => {
        saved.portForwards = update.portForwards
      })
    },
    connectionManager: { getConnection: vi.fn<() => { id: string } | undefined>(() => conn) },
    portForwardManager: {
      closeStaleForwards: vi.fn(async () => {}),
      listForwards: vi.fn(() => [...active]),
      addForward: vi.fn(
        async (
          connectionId: string,
          _conn: unknown,
          localPort: number,
          remoteHost: string,
          remotePort: number,
          label?: string
        ) => {
          const entry = {
            id: `pf-${active.length + 1}`,
            connectionId,
            localPort,
            remoteHost,
            remotePort,
            label
          }
          active.push(entry)
          return entry
        }
      ),
      removeForwardAndWait: vi.fn(async (id: string) => {
        const index = active.findIndex((entry) => entry.id === id)
        return index !== -1 ? active.splice(index, 1)[0] : null
      })
    },
    hostServerStatus: vi.fn<() => { kind: 'managed'; environmentId: string } | undefined>(() => ({
      kind: 'managed',
      environmentId: 'env-1'
    })),
    broadcastPortForwards: vi.fn()
  }
})

vi.mock('../../ssh/ssh-target-registry', () => ({ getSshTargetRegistryStore: () => h.store }))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: h.connectionManager,
  portForwardManager: h.portForwardManager,
  getCurrentMainWindow: () => null
}))
vi.mock('./ssh-renderer-broadcast', () => ({ broadcastPortForwards: h.broadcastPortForwards }))
vi.mock('../../ssh/ssh-host-server-status', () => ({ getSshHostServerStatus: h.hostServerStatus }))

import { restorePortForwards } from './ssh-port-forward-persistence'
import { restoreManagedHostPortForwards } from './ssh-managed-port-forward-restore'

const FORWARD = { localPort: 4100, remoteHost: '127.0.0.1', remotePort: 7860, label: 'app' }

describe('saved port forward restore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.active.length = 0
    h.saved.portForwards = [{ ...FORWARD }]
  })

  it('closes forwards bound to a replaced transport before re-adding the saved ones', async () => {
    await restorePortForwards('t1', () => null)
    expect(h.portForwardManager.closeStaleForwards).toHaveBeenCalledWith('t1', h.conn)
    expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
    expect(h.portForwardManager.closeStaleForwards.mock.invocationCallOrder[0]).toBeLessThan(
      h.portForwardManager.addForward.mock.invocationCallOrder[0]
    )
  })

  it('leaves a forward that is still live on the current transport alone', async () => {
    await restorePortForwards('t1', () => null)
    await restorePortForwards('t1', () => null)
    expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
    expect(h.saved.portForwards).toEqual([FORWARD])
  })

  it('restores a managed host once even when two connects race', async () => {
    await Promise.all([restoreManagedHostPortForwards('t1'), restoreManagedHostPortForwards('t1')])
    expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
    expect(h.broadcastPortForwards).toHaveBeenCalledWith(expect.any(Function), 't1')
  })

  it('does nothing for a host that is not managed', async () => {
    h.hostServerStatus.mockReturnValueOnce(undefined)
    await restoreManagedHostPortForwards('t1')
    expect(h.portForwardManager.addForward).not.toHaveBeenCalled()
  })

  it('closes a forward whose add finished after the host disconnected', async () => {
    h.portForwardManager.addForward.mockImplementationOnce(
      async (connectionId, _conn, localPort) => {
        const entry = {
          id: 'pf-late',
          connectionId,
          localPort,
          remoteHost: '127.0.0.1',
          remotePort: 7860,
          label: undefined
        }
        h.active.push(entry)
        h.connectionManager.getConnection.mockReturnValue(undefined)
        return entry
      }
    )
    await restorePortForwards('t1', () => null)
    expect(h.portForwardManager.removeForwardAndWait).toHaveBeenCalledWith('pf-late')
    expect(h.active).toEqual([])
    h.connectionManager.getConnection.mockReturnValue(h.conn)
  })

  it('skips a queued managed restore once the host stopped being managed', async () => {
    let release: () => void = () => {}
    h.portForwardManager.closeStaleForwards.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    )
    const first = restoreManagedHostPortForwards('t1')
    await vi.waitFor(() => expect(h.portForwardManager.closeStaleForwards).toHaveBeenCalled())
    const second = restoreManagedHostPortForwards('t1')
    h.hostServerStatus.mockReturnValue(undefined)
    release()
    await Promise.all([first, second])
    expect(h.portForwardManager.closeStaleForwards).toHaveBeenCalledTimes(1)
    h.hostServerStatus.mockReturnValue({ kind: 'managed', environmentId: 'env-1' })
  })
})
