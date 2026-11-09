import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseProcNetListeners } from './loopback-callback-listener'
import { grantLoopbackCallbackPort } from './loopback-callback-tunnel'
import {
  loopbackRequestOf,
  requestOf
} from '../../../../ipc/runtime-environments/auth-callback-forward-requests'

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
// Port 42301 = 0xA53D.
const line = (address: string, state: string, uid: number, inode: string): string =>
  `   0: ${address}:A53D 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0`

describe('parseProcNetListeners', () => {
  it('finds loopback and any-address listeners on the port, not other states or interfaces', () => {
    const text = [
      HEADER,
      line('0100007F', '0A', 1000, '111'),
      line('00000000', '0A', 1000, '222'),
      line('0100007F', '01', 1000, '333'),
      line('0A00000A', '0A', 1000, '444')
    ].join('\n')
    expect(parseProcNetListeners(text, 42301)).toEqual([
      { uid: 1000, inode: '111' },
      { uid: 1000, inode: '222' }
    ])
    expect(parseProcNetListeners(text, 42302)).toEqual([])
  })

  it('reads IPv6 loopback and any-address listeners', () => {
    const v6 = [
      HEADER,
      line('00000000000000000000000001000000', '0A', 1000, '555'),
      line('00000000000000000000000000000000', '0A', 1000, '666')
    ].join('\n')
    expect(parseProcNetListeners(v6, 42301).map((l) => l.inode)).toEqual(['555', '666'])
  })
})

describe('grantLoopbackCallbackPort', () => {
  afterEach(() => vi.useRealTimers())

  it('refuses a port nobody on the host is listening on', async () => {
    await expect(
      grantLoopbackCallbackPort(42301, { listenerPids: async () => [] })
    ).rejects.toThrow('loopback_callback_not_listening')
  })

  it('ends when the agent stops listening', async () => {
    vi.useFakeTimers()
    let pids = [123]
    const grant = await grantLoopbackCallbackPort(42301, {
      listenerPids: async () => pids,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(grant.ended.aborted).toBe(false)
    pids = []
    await vi.advanceTimersByTimeAsync(150)
    expect(grant.ended.aborted).toBe(true)
  })

  it('ends a few seconds after the callback was served, even if the agent keeps listening', async () => {
    vi.useFakeTimers()
    const grant = await grantLoopbackCallbackPort(42301, {
      listenerPids: async () => [123],
      pollMs: 60_000
    })
    grant.streamClosed()
    // A second stream (favicon) does not extend the grace period.
    await vi.advanceTimersByTimeAsync(2_000)
    grant.streamClosed()
    expect(grant.ended.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(grant.ended.aborted).toBe(true)
  })
})

describe('callback forward requests', () => {
  it('accepts an agent loopback callback without a sign-in flow', () => {
    expect(loopbackRequestOf({ environmentId: 'env', port: 42301 })).toEqual({
      environmentId: 'env',
      port: 42301
    })
  })

  it('rejects privileged, fractional or missing ports and non-string environments', () => {
    for (const value of [
      { environmentId: 'env', port: 80 },
      { environmentId: 'env', port: 4230.5 },
      { environmentId: 'env' },
      { environmentId: 7, port: 42301 },
      null,
      'env'
    ]) {
      expect(loopbackRequestOf(value)).toBeNull()
    }
    // Orca's own sign-in still needs its flow id.
    expect(requestOf({ environmentId: 'env', port: 42301 })).toBeNull()
    expect(requestOf({ environmentId: 'env', flowId: 'f', port: 42301 })).toEqual({
      environmentId: 'env',
      flowId: 'f',
      port: 42301
    })
  })
})
