/** #29626: a refused quiet retry republishes only what is still true about the host. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState, SshManagedServerStatus } from '../../../shared/ssh-types'

const context = vi.hoisted(() => {
  const holder: { state?: SshConnectionState } = {}
  return holder
})

vi.mock('./ssh-ipc-context', () => ({
  connectionManager: { getState: () => context.state },
  getCurrentMainWindow: () => null
}))
vi.mock('./ssh-renderer-broadcast', () => ({
  broadcastSshState: vi.fn(),
  getPublicSshState: vi.fn(() => undefined)
}))

const { restoreKeptHostServer } = await import('./ssh-host-server-connect')
const { broadcastSshState } = await import('./ssh-renderer-broadcast')
const { getSshHostServerStatus, setSshHostServerStatus } =
  await import('../../ssh/ssh-host-server-status')

const kept: SshManagedServerStatus = {
  kind: 'relay',
  reason: 'relay_terminals_live',
  terminals: 1,
  bridged: true
}

beforeEach(() => {
  vi.mocked(broadcastSshState).mockClear()
  context.state = { targetId: 'ssh-1', status: 'connected', error: null, reconnectAttempt: 0 }
  setSshHostServerStatus('ssh-1', kept)
})

describe('restoring a host kept for bridged terminals', () => {
  it('republishes it connected while its transport is connected', () => {
    expect(restoreKeptHostServer('ssh-1')).toMatchObject({
      status: 'connected',
      managedServer: kept
    })
    expect(broadcastSshState).toHaveBeenCalledWith(
      expect.any(Function),
      'ssh-1',
      expect.objectContaining({ status: 'connected', managedServer: kept })
    )
  })

  it('broadcasts the real transport state when the session dropped during the retry', () => {
    context.state = {
      targetId: 'ssh-1',
      status: 'reconnecting',
      error: 'connection lost',
      reconnectAttempt: 1
    }

    expect(restoreKeptHostServer('ssh-1')).toMatchObject({ status: 'reconnecting' })
    expect(broadcastSshState).toHaveBeenCalledWith(
      expect.any(Function),
      'ssh-1',
      expect.objectContaining({ status: 'reconnecting', managedServer: kept })
    )
    expect(getSshHostServerStatus('ssh-1')).toEqual(kept)
  })

  it('leaves a newer status alone', () => {
    const newer: SshManagedServerStatus = { kind: 'managed', environmentId: 'env-1' }
    setSshHostServerStatus('ssh-1', newer)

    expect(restoreKeptHostServer('ssh-1')).toMatchObject({ status: 'connected' })
    expect(broadcastSshState).not.toHaveBeenCalled()
    expect(getSshHostServerStatus('ssh-1')).toEqual(newer)
  })
})
