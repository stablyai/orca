import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortForwardEntry, SavedPortForward } from '../../../shared/ssh-types'

const h = vi.hoisted(() => {
  const conn = {
    id: 'conn',
    generation: 1,
    getConnectGeneration: () => conn.generation,
    isDisposed: () => false
  }
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
    connectionManager: { getConnection: vi.fn<() => typeof conn | undefined>(() => conn) },
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
    hostServerStatus: vi.fn<
      () =>
        | { kind: 'managed'; environmentId: string }
        | { kind: 'setting-up'; phase: 'deploying' }
        | undefined
    >(() => ({
      kind: 'managed',
      environmentId: 'env-1'
    })),
    broadcastPortForwards: vi.fn()
  }
})

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => h.store
}))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: h.connectionManager,
  portForwardManager: h.portForwardManager,
  getCurrentMainWindow: () => null
}))
vi.mock('./ssh-renderer-broadcast', () => ({ broadcastPortForwards: h.broadcastPortForwards }))
vi.mock('../../ssh/ssh-host-server-status', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSshHostServerStatus: h.hostServerStatus
}))

import { persistPortForwards, restorePortForwards } from './ssh-port-forward-persistence'
import {
  forgetForwardFailures,
  listUnrestoredPortForwards,
  recordForwardFailure
} from './ssh-port-forward-unrestored'
import { PortForwardTornDownError } from '../../ssh/port-forwarding/ssh-port-forward'
import { connectInFlight } from './ssh-connect-attempt-registry'
import { getSshProviderAuthority } from '../../ssh/ssh-provider-authority'
import {
  restoreManagedHostPortForwards,
  serializePortForwardChange
} from './ssh-managed-port-forward-restore'

const FORWARD = { localPort: 4100, remoteHost: '127.0.0.1', remotePort: 7860, label: 'app' }

describe('saved port forward restore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.active.length = 0
    h.saved.portForwards = [{ ...FORWARD }]
    // Each case starts on a transport no earlier case restored on, with no remembered failures.
    h.conn.generation += 1
    forgetForwardFailures('t1')
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

  // #32484: after a restart that restored nothing, re-adding one forward used to save only that one.
  it('keeps unrestored saved forwards when the user adds or removes another', () => {
    const other = { localPort: 4200, remoteHost: '127.0.0.1', remotePort: 7870, label: 'api' }
    h.saved.portForwards = [{ ...FORWARD }, { ...other }]
    const added = {
      id: 'pf-1',
      connectionId: 't1',
      localPort: 4300,
      remoteHost: 'db',
      remotePort: 5432
    }
    h.active.push(added)
    persistPortForwards('t1')
    expect(h.saved.portForwards).toEqual([
      { localPort: 4300, remoteHost: 'db', remotePort: 5432, label: undefined },
      FORWARD,
      other
    ])
    h.active.length = 0
    persistPortForwards('t1', added)
    expect(h.saved.portForwards).toEqual([FORWARD, other])
    persistPortForwards('t1', FORWARD)
    expect(h.saved.portForwards).toEqual([other])
  })

  it('restores once per transport, and again on a new one', async () => {
    await restoreManagedHostPortForwards('t1')
    await restoreManagedHostPortForwards('t1')
    expect(h.portForwardManager.closeStaleForwards).toHaveBeenCalledTimes(1)
    h.conn.generation += 1
    await restoreManagedHostPortForwards('t1')
    expect(h.portForwardManager.closeStaleForwards).toHaveBeenCalledTimes(2)
  })

  it('restores over a managed tunnel before any status lands, but never mid-setup', async () => {
    h.hostServerStatus.mockReturnValue({ kind: 'setting-up', phase: 'deploying' })
    await restoreManagedHostPortForwards('t1', { tunnelUp: true })
    expect(h.portForwardManager.addForward).not.toHaveBeenCalled()
    h.hostServerStatus.mockReturnValue(undefined)
    await restoreManagedHostPortForwards('t1')
    expect(h.portForwardManager.addForward).not.toHaveBeenCalled()
    await restoreManagedHostPortForwards('t1', { tunnelUp: true })
    expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
    h.hostServerStatus.mockReturnValue({ kind: 'managed', environmentId: 'env-1' })
  })

  it('retries a forward that failed to bind on the same transport', async () => {
    h.portForwardManager.addForward.mockRejectedValueOnce(new Error('EADDRINUSE'))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await restoreManagedHostPortForwards('t1')
      expect(h.active).toEqual([])
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 30_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.active).toEqual([expect.objectContaining({ localPort: FORWARD.localPort })])
    } finally {
      vi.useRealTimers()
    }
  })

  // With system SSH every attempt is a new login, so per-call triggers must not storm.
  it('restores a forward that closed again, at most once per pause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await restoreManagedHostPortForwards('t1')
      h.active.length = 0
      for (let call = 0; call < 5; call += 1) {
        await restoreManagedHostPortForwards('t1', { tunnelUp: true })
      }
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 30_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off a forward that keeps failing, and lists it with why', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      h.portForwardManager.addForward.mockRejectedValue(new Error('port in use'))
      await restoreManagedHostPortForwards('t1')
      expect(listUnrestoredPortForwards('t1')).toEqual([{ ...FORWARD, error: 'port in use' }])
      vi.setSystemTime(Date.now() + 30_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(2)
      // The second failure doubles the wait, so the next pause alone doesn't retry it.
      vi.setSystemTime(Date.now() + 30_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(2)
      vi.setSystemTime(Date.now() + 30_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(3)
    } finally {
      h.portForwardManager.addForward.mockReset()
      vi.useRealTimers()
    }
  })

  it('replaces an unrestored mapping whose local port a new forward took', () => {
    h.active.push({
      id: 'pf-1',
      connectionId: 't1',
      localPort: FORWARD.localPort,
      remoteHost: 'db',
      remotePort: 5432
    })
    persistPortForwards('t1')
    expect(h.saved.portForwards).toEqual([
      { localPort: FORWARD.localPort, remoteHost: 'db', remotePort: 5432, label: undefined }
    ])
  })

  it('waits for an edit in progress, so it cannot reopen the mapping being replaced', async () => {
    let finishEdit: (() => void) | null = null
    const edit = serializePortForwardChange('t1', async () => {
      await new Promise<void>((resolve) => (finishEdit = resolve))
      const moved = { id: 'pf-9', connectionId: 't1', ...FORWARD, localPort: 4999 }
      h.active.push(moved)
      persistPortForwards('t1', FORWARD)
    })
    await vi.waitFor(() => expect(finishEdit).not.toBeNull())
    const restore = restoreManagedHostPortForwards('t1')
    finishEdit!()
    await Promise.all([edit, restore])
    expect(h.portForwardManager.addForward).not.toHaveBeenCalled()
    expect(h.saved.portForwards).toEqual([{ ...FORWARD, localPort: 4999 }])
  })

  it('leaves a host mid-connect to the connect, even with its tunnel up', async () => {
    h.hostServerStatus.mockReturnValue(undefined)
    connectInFlight.set('t1', {
      authority: getSshProviderAuthority('t1'),
      promise: new Promise(() => {})
    })
    try {
      await restoreManagedHostPortForwards('t1', { tunnelUp: true })
      expect(h.portForwardManager.addForward).not.toHaveBeenCalled()
    } finally {
      connectInFlight.delete('t1')
      h.hostServerStatus.mockReturnValue({ kind: 'managed', environmentId: 'env-1' })
    }
  })

  it('records no backoff when a teardown cancels the start', async () => {
    h.portForwardManager.addForward.mockRejectedValueOnce(new PortForwardTornDownError())
    await restoreManagedHostPortForwards('t1')
    h.conn.generation += 1
    await restoreManagedHostPortForwards('t1')
    expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(2)
  })

  it('retries a failed forward at once on a reconnected transport', async () => {
    h.portForwardManager.addForward.mockRejectedValueOnce(new Error('channel open failed'))
    await restoreManagedHostPortForwards('t1')
    h.conn.generation += 1
    await restoreManagedHostPortForwards('t1')
    expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(2)
  })

  it('keeps backing off a forward whose ssh restarts and exits again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Starts, then its ssh dies after the start grace; the close callback records it.
      await restoreManagedHostPortForwards('t1')
      h.active.length = 0
      recordForwardFailure('t1', FORWARD, 'exited unexpectedly')
      vi.setSystemTime(Date.now() + 30_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(2)
      // The restart succeeds, then dies again: the streak continues, so the wait doubles.
      h.active.length = 0
      recordForwardFailure('t1', FORWARD, 'exited unexpectedly')
      vi.setSystemTime(Date.now() + 30_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(2)
      vi.setSystemTime(Date.now() + 30_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh backoff for a forward that stayed up before it died', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      recordForwardFailure('t1', FORWARD, 'exited unexpectedly', 'exit')
      recordForwardFailure('t1', FORWARD, 'exited unexpectedly', 'exit')
      vi.setSystemTime(Date.now() + 60_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
      // Healthy for 5 minutes, then it dies: the next retry waits the base 30 s, not 120 s.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      h.active.length = 0
      recordForwardFailure('t1', FORWARD, 'exited unexpectedly', 'exit')
      vi.setSystemTime(Date.now() + 30_000)
      await restoreManagedHostPortForwards('t1')
      expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
