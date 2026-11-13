import { describe, expect, it, vi } from 'vitest'
import { createUndialableDirectClient, skipsDirectEndpoint } from './undialable-direct-endpoint'
import { relay } from './mobile-endpoint-supervisor-test-fakes'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('skipsDirectEndpoint', () => {
  it('skips a link-local endpoint only when relay can carry the host', () => {
    expect(skipsDirectEndpoint({ endpoint: 'ws://169.254.10.20:6768', relay })).toBe(true)
    expect(skipsDirectEndpoint({ endpoint: 'ws://[fe80::1]:6768', relay })).toBe(true)
    // Without relay the direct session is the only route to relay credentials.
    expect(skipsDirectEndpoint({ endpoint: 'ws://169.254.10.20:6768' })).toBe(false)
  })

  it('keeps LAN, Tailscale and loopback endpoints dialable', () => {
    for (const endpoint of [
      'ws://192.168.1.20:6768',
      'ws://100.101.102.103:6768',
      'ws://127.0.0.1:6768',
      'wss://desktop.example.ts.net'
    ]) {
      expect(skipsDirectEndpoint({ endpoint, relay }), endpoint).toBe(false)
    }
  })
})

describe('createUndialableDirectClient', () => {
  it('reports reconnecting and holds requests until cutover closes it', async () => {
    const client = createUndialableDirectClient()
    const states: string[] = []
    client.onStateChange((state) => states.push(state))
    expect(client.getState()).toBe('reconnecting')

    const pending = client.sendRequest('session.tabs.list')
    client.close()

    await expect(pending).rejects.toThrow('Client closed')
    expect(states).toEqual(['disconnected'])
    await expect(client.sendRequest('status.get')).rejects.toThrow('Client closed')
  })

  it('honours failWhenDisconnected, timeouts and abort signals', async () => {
    vi.useFakeTimers()
    try {
      const client = createUndialableDirectClient()
      await expect(
        client.sendRequest('status.get', undefined, { failWhenDisconnected: true })
      ).rejects.toThrow('Not connected: status.get')

      const timed = client.sendRequest('status.get', undefined, { timeoutMs: 1_000 })
      const timedOutcome = expect(timed).rejects.toThrow('Timed out while connecting')
      await vi.advanceTimersByTimeAsync(1_000)
      await timedOutcome

      const controller = new AbortController()
      const aborted = client.sendRequest('status.get', undefined, { signal: controller.signal })
      controller.abort(new Error('caller gave up'))
      await expect(aborted).rejects.toThrow('caller gave up')
    } finally {
      vi.useRealTimers()
    }
  })
})
