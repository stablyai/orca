import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostRequestEvent } from '../../../../shared/browser/client-hosting/browser-client-host-request-protocol'
import { BrowserHostRequestRegistry } from './browser-host-request-registry'

function desktop(requests: BrowserHostRequestRegistry, pairedDeviceId: string) {
  const asked: BrowserClientHostRequestEvent[] = []
  const unregister = requests.register({ pairedDeviceId, emit: (event) => asked.push(event) })
  const answer = (browserHostClientId?: string) => {
    const request = asked.at(-1)
    if (!request) {
      throw new Error(`${pairedDeviceId} was not asked`)
    }
    return requests.settle(
      { pairedDeviceId },
      { requestId: request.requestId, ...(browserHostClientId ? { browserHostClientId } : {}) }
    )
  }
  return { asked, answer, unregister }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserHostRequestRegistry with two paired desktops', () => {
  it('asks only the newest desktop, so one lease answers concurrent pages', async () => {
    const requests = new BrowserHostRequestRegistry()
    const older = desktop(requests, 'device-a')
    const newer = desktop(requests, 'device-b')

    const first = requests.request()
    const second = requests.request()
    // A device cannot answer a request sent to another.
    const sentToNewer = {
      requestId: newer.asked[0]?.requestId ?? '',
      browserHostClientId: 'host-a'
    }
    expect(requests.settle({ pairedDeviceId: 'device-a' }, sentToNewer)).toBe(false)
    expect(newer.answer('host-b')).toBe(true)

    const expected = { browserHostClientId: 'host-b', pairedDeviceId: 'device-b' }
    await expect(first).resolves.toEqual(expected)
    await expect(second).resolves.toEqual(expected)
    expect(newer.asked).toHaveLength(1)
    expect(older.asked).toHaveLength(0)
  })

  it('asks the other desktop when the newest declines', async () => {
    const requests = new BrowserHostRequestRegistry()
    const older = desktop(requests, 'device-a')
    const newer = desktop(requests, 'device-b')

    const hosted = requests.request()
    newer.answer()
    await flush()
    older.answer('host-a')

    await expect(hosted).resolves.toEqual({
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a'
    })
  })

  // A silent desktop may still take its lease; asking another would leave two and make selection ambiguous.
  it('never asks a second desktop after the first goes silent', async () => {
    vi.useFakeTimers()
    const requests = new BrowserHostRequestRegistry({ desktopTimeoutMs: 1_000 })
    const older = desktop(requests, 'device-a')
    desktop(requests, 'device-b')

    const timedOut = requests.request()
    const rejected = expect(timedOut).rejects.toThrow('browser_host_unavailable')
    await vi.advanceTimersByTimeAsync(1_000)

    await rejected
    expect(older.asked).toHaveLength(0)
  })
})
