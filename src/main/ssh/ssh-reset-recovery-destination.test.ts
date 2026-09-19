import { expect, it, vi } from 'vitest'
import { parseSshConnectionDestination } from './ssh-connection-destination'
import { captureSshResetRecoveryDestination } from './ssh-reset-recovery-destination'
import { parseSshRelayResetIntent } from './ssh-relay-reset-intent'

function fixture() {
  const destination = parseSshConnectionDestination({
    version: 1,
    transport: 'ssh2',
    host: 'resolved.example',
    port: 22,
    username: 'user',
    hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
    proxyRouteDigest: 'a'.repeat(64)
  })
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId: 'target',
    targetGeneration: 1,
    targetRoutingDigest: 'a'.repeat(64),
    clientInstanceId: 'old-client',
    serverBuildId: 'build',
    destination,
    endpoint: {
      relayDir: '/relay',
      runtimePath: '/bun',
      runtimeKind: 'bun',
      sockPath: '/sock',
      credentialFile: '/credential',
      relayPlatform: 'linux-x64'
    },
    request: {
      version: 1,
      operationId: 'operation',
      runtimeIncarnation: 'runtime',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  const connection = {
    exec: vi.fn(),
    usesSystemSshTransport: vi.fn(() => false),
    getExecutionDestination: vi.fn(() => destination as typeof destination | undefined),
    getTransportGeneration: vi.fn(() => 42)
  }
  return { destination, intent, connection }
}

it('accepts a new connection matching persisted destination without reusing its old generation', () => {
  const f = fixture()
  expect(captureSshResetRecoveryDestination(f.intent, f.connection)).not.toThrow()
})

it('refuses legacy evidence without destination', () => {
  const f = fixture()
  expect(() =>
    captureSshResetRecoveryDestination({ ...f.intent, destination: undefined }, f.connection)
  ).toThrow('destination_required')
})

it.each(['host', 'username', 'port', 'hostKeyFingerprint', 'proxyRouteDigest'] as const)(
  'refuses a persisted %s mismatch',
  (field) => {
    const f = fixture()
    const replacement =
      field === 'port'
        ? 2222
        : field === 'hostKeyFingerprint'
          ? `SHA256:${'B'.repeat(42)}A`
          : field === 'proxyRouteDigest'
            ? 'b'.repeat(64)
            : 'other'
    f.connection.getExecutionDestination.mockReturnValue(
      parseSshConnectionDestination({ ...f.destination, [field]: replacement })
    )
    expect(() => captureSshResetRecoveryDestination(f.intent, f.connection)).toThrow(
      'destination_changed'
    )
  }
)

it.each(['transport', 'generation', 'snapshot', 'disconnected'])(
  'invalidates retained authority after %s changes',
  (change) => {
    const f = fixture()
    const assertCurrent = captureSshResetRecoveryDestination(f.intent, f.connection)
    if (change === 'transport') {
      f.connection.usesSystemSshTransport.mockReturnValue(true)
    }
    if (change === 'generation') {
      f.connection.getTransportGeneration.mockReturnValue(43)
    }
    if (change === 'snapshot') {
      f.connection.getExecutionDestination.mockReturnValue(
        parseSshConnectionDestination(f.destination)
      )
    }
    if (change === 'disconnected') {
      f.connection.getExecutionDestination.mockReturnValue(undefined)
    }
    expect(assertCurrent).toThrow('destination_changed')
  }
)

it('refuses system SSH even if it exposes a stale ssh2 snapshot', () => {
  const f = fixture()
  f.connection.usesSystemSshTransport.mockReturnValue(true)
  expect(() => captureSshResetRecoveryDestination(f.intent, f.connection)).toThrow(
    'destination_changed'
  )
})
