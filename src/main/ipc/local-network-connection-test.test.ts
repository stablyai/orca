import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { testLocalNetworkConnection } from './local-network-connection-test'

describe('testLocalNetworkConnection', () => {
  it('runs a bounded Electron child probe and reports a verified connection', async () => {
    const runChild = vi.fn((_file, _args, _options, callback) => callback(null, '', ''))

    await expect(
      testLocalNetworkConnection(
        { host: '192.168.1.20', port: 3000 },
        { platform: 'darwin', now: () => 1234, runChild }
      )
    ).resolves.toEqual({
      ok: true,
      host: '192.168.1.20',
      port: 3000,
      testedAt: 1234
    })
    expect(runChild).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['192.168.1.20', '3000']),
      expect.objectContaining({
        timeout: 5000,
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' })
      }),
      expect.any(Function)
    )
  })

  it('rejects a hostname that resolves to loopback in the real child probe', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener address')
    }

    try {
      await expect(
        testLocalNetworkConnection(
          { host: '2130706433', port: address.port },
          { platform: 'darwin' }
        )
      ).resolves.toMatchObject({ ok: false, failure: 'invalid-target' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each([
    ['INVALID_TARGET', 'invalid-target'],
    ['ETIMEDOUT', 'timeout'],
    ['ECONNREFUSED', 'refused'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['ENOTFOUND', 'unresolved']
  ] as const)('maps %s without claiming a permission denial', async (stderr, failure) => {
    const runChild = vi.fn((_file, _args, _options, callback) =>
      callback(Object.assign(new Error(stderr), { code: 1 }), '', stderr)
    )

    await expect(
      testLocalNetworkConnection(
        { host: 'devbox.local', port: 8080 },
        { platform: 'darwin', runChild }
      )
    ).resolves.toMatchObject({ ok: false, failure })
  })

  it.each([
    { host: '127.0.0.1', port: 3000 },
    { host: 'localhost', port: 3000 },
    { host: 'service.localhost', port: 3000 },
    { host: '8.8.8.8', port: 53 },
    { host: 'https://devbox.local', port: 443 },
    { host: 'devbox.local', port: 0 }
  ])('rejects a target that does not test a LAN connection: $host:$port', async (target) => {
    const runChild = vi.fn()

    await expect(
      testLocalNetworkConnection(target, { platform: 'darwin', runChild })
    ).resolves.toMatchObject({ ok: false, failure: 'invalid-target' })
    expect(runChild).not.toHaveBeenCalled()
  })
})
