import { createHash } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  clientInstances,
  nextSshClientCreation,
  resetSshConnectionMocks,
  resolveWithSshGMock,
  ssh2Mock,
  VALID_ED25519_HOST_KEY
} from './ssh-connection-test-harness'
import { createCallbacks, createTarget, createResolvedConfig } from './ssh-connection-test-fixtures'
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

beforeEach(() => {
  resetSshConnectionMocks()
})

it('captures only the successful endpoint and accepted key, not the saved alias', async () => {
  resolveWithSshGMock.mockResolvedValue(
    createResolvedConfig({
      hostname: 'resolved.example',
      port: 2222,
      user: 'resolved-user',
      proxyUseFdpass: false
    })
  )
  const conn = new SshConnection(createTarget({ configHost: 'alias' }), createCallbacks())
  expect(conn.getExecutionDestination()).toBeUndefined()
  try {
    await conn.connect()
    const destination = conn.getExecutionDestination()
    expect(destination).toEqual({
      version: 1,
      transport: 'ssh2',
      host: 'resolved.example',
      port: 2222,
      username: 'resolved-user',
      hostKeyFingerprint: `SHA256:${createHash('sha256').update(VALID_ED25519_HOST_KEY).digest('base64').replace(/=+$/, '')}`,
      proxyRouteDigest: createHash('sha256').update('null').digest('hex')
    })
    expect(Object.isFrozen(destination)).toBe(true)
    expect(conn.getExecutionDestination()).toBe(destination)
  } finally {
    await conn.disconnect()
  }
  expect(conn.getExecutionDestination()).toBeUndefined()
})

it('does not publish an accepted key until authentication succeeds', async () => {
  ssh2Mock.connectBehavior = 'pending'
  const conn = new SshConnection(createTarget(), createCallbacks())
  const created = nextSshClientCreation()
  const connecting = conn.connect()
  await created
  expect(conn.getExecutionDestination()).toBeUndefined()
  const rejected = expect(connecting).rejects.toThrow()
  await conn.disconnect()
  await rejected
  clientInstances[0].emit('ready')
  expect(conn.getExecutionDestination()).toBeUndefined()
})

it('invalidates identity immediately on transport loss', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  try {
    await conn.connect()
    expect(conn.getExecutionDestination()).toBeDefined()
    clientInstances[0].emit('end')
    expect(conn.getExecutionDestination()).toBeUndefined()
  } finally {
    await conn.disconnect()
  }
})

it('does not publish an accepted key from failed authentication', async () => {
  ssh2Mock.connectBehavior = 'error'
  ssh2Mock.connectErrorMessage = 'Authentication failed'
  const conn = new SshConnection(createTarget(), createCallbacks())
  try {
    await expect(conn.connect()).rejects.toThrow()
    expect(ssh2Mock.lastHostKeyAccepted).toBe(true)
    expect(conn.getExecutionDestination()).toBeUndefined()
  } finally {
    await conn.disconnect()
  }
})

it('never publishes identity from a rejected host key', async () => {
  ssh2Mock.presentedHostKey = Buffer.from('invalid host key')
  const conn = new SshConnection(createTarget(), createCallbacks())
  try {
    await expect(conn.connect()).rejects.toThrow()
    expect(conn.getExecutionDestination()).toBeUndefined()
  } finally {
    await conn.disconnect()
  }
})

it('does not treat a system SSH probe as command-channel destination evidence', async () => {
  const conn = new SshConnection(createTarget({ configHost: 'alias' }), createCallbacks())
  resolveWithSshGMock.mockResolvedValue(createResolvedConfig({ proxyUseFdpass: true }))
  try {
    await conn.connect()
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(conn.getExecutionDestination()).toBeUndefined()
  } finally {
    await conn.disconnect()
  }
})
