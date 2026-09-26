import { describe, expect, it, vi, beforeEach } from 'vitest'
import { clientInstances, resetSshConnectionMocks } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import type { MockSshClient } from './ssh-connection-test-harness'

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

type ConfigWithAlgorithms = {
  algorithms?: { compress?: unknown }
}

// Slice 1 (RED, TDD Phase 1): SSH wire compression for the RFC 4254 dynamic BDP window
// autotuner. High-latency WAN links benefit from zlib@openssh.com compression stacked on
// top of the autotuner's larger receive window, so SshConnection must request it explicitly
// -- ssh2 does not enable compression by default. Production code intentionally NOT touched
// here; ssh-connection.ts still builds `algorithms` only for the serverHostKey override, so
// `algorithms.compress` is undefined until Agent 2 implements it.
describe('SshConnection wire compression', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  it('supplies zlib@openssh.com compression with a none fallback to the ssh2 client on connect', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())

    await conn.connect()

    expect(clientInstances).toHaveLength(1)
    const config = clientInstances[0].lastConnectConfig as ConfigWithAlgorithms
    expect(config.algorithms?.compress).toEqual(['zlib@openssh.com', 'none'])
  })

  it("records the requested compression algorithms on the mock client's lastConnectConfig", async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())

    await conn.connect()

    const client: MockSshClient = clientInstances[0]
    expect(client.lastConnectConfig).toBeDefined()
    const config = client.lastConnectConfig as ConfigWithAlgorithms
    expect(config.algorithms).toBeDefined()
    expect(Array.isArray(config.algorithms?.compress)).toBe(true)
    expect(config.algorithms?.compress).toContain('zlib@openssh.com')
    expect(config.algorithms?.compress).toContain('none')
  })

  it('requests compression on the new ssh2 client after a reconnect cycle', async () => {
    // Why: guards the "compression only applied on the first connect" regression class,
    // mirroring the existing TCP_NODELAY reconnect-cycle coverage. attemptConnect bumps
    // connectGeneration on every call, and both the initial connect and the explicit
    // reconnect path go through doSsh2Connect -> client.connect(), so the fresh client
    // must also negotiate compression -- a WAN link that drops and reconnects must not
    // silently fall back to an uncompressed stream.
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    expect(clientInstances).toHaveLength(1)

    const privateConn = conn as unknown as { attemptConnect: () => Promise<void> }
    await privateConn.attemptConnect()

    expect(clientInstances).toHaveLength(2)
    const reconnectConfig = clientInstances[1].lastConnectConfig as ConfigWithAlgorithms
    expect(reconnectConfig.algorithms?.compress).toEqual(['zlib@openssh.com', 'none'])
  })
})
