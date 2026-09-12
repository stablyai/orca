import { expect, it, vi } from 'vitest'
import {
  captureSshNetworkTunnelBinding,
  type SshNetworkTunnelSessionSnapshot
} from './ssh-relay-network-tunnel-binding'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshConnection } from './ssh-connection'

function fixture() {
  const channel = {}
  const mux = {
    getSourceChannel: vi.fn(() => channel),
    isDisposed: vi.fn(() => false),
    assertWriteSettlement: vi.fn()
  }
  const connection = { getState: vi.fn(() => ({ status: 'connected' })) }
  const snapshot: SshNetworkTunnelSessionSnapshot = {
    mux: mux as unknown as SshChannelMultiplexer,
    connection: connection as unknown as SshConnection,
    providerGeneration: 4,
    resetPending: false,
    owner: {
      mode: 'negotiated',
      clientInstanceId: 'client',
      clientGeneration: 2,
      ownerGeneration: 3,
      ownerLease: 'lease'
    }
  }
  const read = vi.fn(() => snapshot as SshNetworkTunnelSessionSnapshot | null)
  return { mux, connection, snapshot, read }
}

it('separates reset admission from authority needed by admitted traffic', () => {
  const f = fixture()
  const captured = captureSshNetworkTunnelBinding(f.read)
  f.snapshot.resetPending = true
  expect(() => captured.assertCurrent()).not.toThrow()
  expect(() => captured.assertAdmission()).toThrow('admission_closed')
  expect(() => captureSshNetworkTunnelBinding(f.read)).toThrow('session_unavailable')
})

it.each([
  'mux',
  'connection',
  'provider',
  'channel',
  'client',
  'client-generation',
  'owner-generation',
  'lease',
  'disconnected',
  'disposed',
  'missing'
] as const)('refuses captured authority after %s changes', (change) => {
  const f = fixture()
  const captured = captureSshNetworkTunnelBinding(f.read)
  switch (change) {
    case 'mux':
      f.snapshot.mux = {} as SshChannelMultiplexer
      break
    case 'connection':
      f.snapshot.connection = {} as SshConnection
      break
    case 'provider':
      f.snapshot.providerGeneration++
      break
    case 'channel':
      f.mux.getSourceChannel.mockReturnValue({})
      break
    case 'client':
      f.snapshot.owner.clientInstanceId = 'other'
      break
    case 'client-generation':
      f.snapshot.owner.clientGeneration++
      break
    case 'owner-generation':
      f.snapshot.owner.ownerGeneration++
      break
    case 'lease':
      f.snapshot.owner.ownerLease = 'other'
      break
    case 'disconnected':
      f.connection.getState.mockReturnValue({ status: 'disconnected' })
      break
    case 'disposed':
      f.mux.isDisposed.mockReturnValue(true)
      break
    case 'missing':
      f.read.mockReturnValue(null)
      break
  }
  expect(() => captured.assertCurrent()).toThrow('session_changed')
  expect(captured.owner.ownerLease).toBe('lease')
})

it('requires physical write settlement before admitting a tunnel', () => {
  const f = fixture()
  f.mux.assertWriteSettlement.mockImplementation(() => {
    throw new Error('callback required')
  })
  expect(() => captureSshNetworkTunnelBinding(f.read)).toThrow('callback required')
})
