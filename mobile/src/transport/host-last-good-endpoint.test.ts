import { describe, expect, it, vi } from 'vitest'
import { createHostLastGoodEndpointUpdater } from './host-last-good-endpoint'

describe('host last-good endpoint persistence', () => {
  it('does not rewrite storage when the successful endpoint is unchanged', async () => {
    let hosts = [{ id: 'host-1', lastGoodEndpoint: 'ws://lan:6768' }]
    const write = vi.fn()
    const updateLastGood = createHostLastGoodEndpointUpdater(async (update) => {
      const next = update(hosts)
      if (next !== hosts) {
        hosts = next
        write()
      }
    })

    await updateLastGood('host-1', 'ws://lan:6768')
    expect(write).not.toHaveBeenCalled()

    await updateLastGood('host-1', 'ws://tailscale:6768')
    expect(write).toHaveBeenCalledOnce()
    expect(hosts[0]!.lastGoodEndpoint).toBe('ws://tailscale:6768')
  })
})
