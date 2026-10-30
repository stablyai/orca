import { Socket } from 'node:net'
import * as net from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { connectNativeBrowserNetworkTarget } from './browser-network-execution-route'

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof net>()
  return { ...actual, connect: vi.fn(actual.connect) }
})

describe('native browser tunnel proxy dial errors', () => {
  it('reports a proxy dial that fails on the next tick as a tunnel error', async () => {
    // Node emits ENETUNREACH or EPERM this way, before any promise continuation runs.
    vi.mocked(net.connect).mockImplementationOnce(() => {
      const socket = new Socket()
      process.nextTick(() => socket.destroy(new Error('connect ENETUNREACH')))
      return socket
    })
    const errors: string[] = []
    // Dial from a plain event-loop callback, as the tunnel does, so nextTick runs before promise jobs.
    await new Promise<void>((resolve) =>
      setImmediate(() =>
        connectNativeBrowserNetworkTarget(
          { host: 'site.invalid', port: 443 },
          { HTTPS_PROXY: 'http://[2001:db8::1]:3128' }
        )
          .on('error', (error) => errors.push(error.message))
          .on('close', resolve)
      )
    )
    expect(errors).toEqual(['connect ENETUNREACH'])
  })
})
