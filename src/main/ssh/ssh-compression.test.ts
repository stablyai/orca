import { describe, expect, it, vi, beforeEach } from 'vitest'
import { clientInstances, resetSshConnectionMocks } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

/**
 * The harness records the ssh2 connect config as `unknown`, so read the one field
 * under test through `in` narrowing rather than asserting a shape the mock never
 * guarantees.
 */
function readCompressAlgorithms(config: unknown): unknown {
  if (!config || typeof config !== 'object' || !('algorithms' in config)) {
    return undefined
  }
  const algorithms = config.algorithms
  if (!algorithms || typeof algorithms !== 'object' || !('compress' in algorithms)) {
    return undefined
  }
  return algorithms.compress
}

// ssh2 negotiates no compression unless asked, so SshConnection has to request
// zlib@openssh.com explicitly for high-latency WAN links, keeping `none` as the
// fallback for servers that refuse the OpenSSH extension.
describe('SshConnection wire compression', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  it('supplies zlib@openssh.com compression with a none fallback to the ssh2 client on connect', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())

    await conn.connect()

    expect(clientInstances).toHaveLength(1)
    expect(readCompressAlgorithms(clientInstances[0].lastConnectConfig)).toEqual([
      'zlib@openssh.com',
      'none'
    ])
  })

  it('requests compression on the new ssh2 client after a reconnect cycle', async () => {
    // Why: guards the "compression only applied on the first connect" regression class,
    // mirroring the existing TCP_NODELAY reconnect-cycle coverage. attemptConnect bumps
    // connectGeneration on every call, and both the initial connect and the explicit
    // reconnect path go through doSsh2Connect -> client.connect(), so the fresh client
    // must also negotiate compression -- a WAN link that drops and reconnects must not
    // silently fall back to an uncompressed stream. connect() itself is guarded once the
    // connection is live, so the reconnect helper is reached through element access.
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    expect(clientInstances).toHaveLength(1)

    await conn['attemptConnect']()

    expect(clientInstances).toHaveLength(2)
    expect(readCompressAlgorithms(clientInstances[1].lastConnectConfig)).toEqual([
      'zlib@openssh.com',
      'none'
    ])
  })
})
