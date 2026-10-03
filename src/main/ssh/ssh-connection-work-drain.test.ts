import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import {
  createCallbacks,
  createTarget,
  fenceSshConnectionWork
} from './ssh-connection-test-fixtures'
import {
  resetSshConnectionMocks,
  pendingSftpCallback,
  ssh2Mock
} from './ssh-connection-test-harness'

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

beforeEach(resetSshConnectionMocks)

it('does not automatically replace an explicitly single-lifetime SSH transport', async () => {
  const options = { automaticReconnect: false }
  const conn = new SshConnection(createTarget(), createCallbacks(), options)
  options.automaticReconnect = true
  await conn.connect()
  const client = conn.getClient()!
  vi.useFakeTimers()
  try {
    client.emit('close')
    expect(conn.getClient()).toBeNull()
    expect(conn.getState().status).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(conn.getClient()).toBeNull()
    expect(conn.getState().reconnectAttempt).toBe(0)
  } finally {
    await conn.disconnect()
    vi.useRealTimers()
  }
})

it('accounts for forward-route startup before reset and blocks new socket factories', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  const release = Promise.withResolvers<void>()
  const preparing = conn.prepareForwardRoute(async () => {
    await release.promise
    return conn.openForwardSocket(() => new EventEmitter())
  })
  const fence = fenceSshConnectionWork(conn)
  const forbidden = vi.fn(() => new EventEmitter())
  expect(() => conn.openForwardSocket(forbidden)).toThrow('admission_closed')
  expect(forbidden).not.toHaveBeenCalled()
  expect(() => fence.assertDrained()).toThrow('not_drained')
  release.resolve()
  const admitted = await preparing
  expect(() => fence.assertDrained()).toThrow('not_drained')
  admitted.emit('close')
  await fence.drain(new AbortController().signal)
})

it('routes actual connection forwarding through admission and rejects a replaced client', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  const client = conn.getClient()!
  const channel = new EventEmitter()
  const socket = new EventEmitter()
  client.forwardOut = vi.fn((_a, _b, _c, _d, callback) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock ssh2 client hands back this EventEmitter as its channel.
    callback?.(undefined, channel as never)
    return client
  })
  conn.forwardOut(client, socket, '127.0.0.1', 0, 'remote', 443, vi.fn())
  const fence = fenceSshConnectionWork(conn)
  expect(() =>
    conn.forwardOut(client, new EventEmitter(), '127.0.0.1', 0, 'remote', 443, vi.fn())
  ).toThrow('admission_closed')
  expect(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in for a different ssh2 client; only its identity is compared.
    conn.forwardOut({} as never, new EventEmitter(), '127.0.0.1', 0, 'remote', 443, vi.fn())
  ).toThrow('client_changed')
  channel.emit('close')
  expect(() => fence.assertDrained()).toThrow('not_drained')
  socket.emit('close')
  await fence.drain(new AbortController().signal)
  expect(client.forwardOut).toHaveBeenCalledOnce()
})

it('tracks exact remote socket forwarding through a late open and physical close', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  const client = conn.getClient()!
  let accept: Parameters<typeof client.openssh_forwardOutStreamLocal>[1] | undefined
  client.openssh_forwardOutStreamLocal = vi.fn((_path, callback) => {
    accept = callback
    return client
  })
  const received = vi.fn()
  conn.forwardStreamLocal(client, '/saved/incumbent.sock', received)
  expect(client.openssh_forwardOutStreamLocal).toHaveBeenCalledWith(
    '/saved/incumbent.sock',
    expect.any(Function)
  )
  const fence = fenceSshConnectionWork(conn)
  expect(() => fence.assertDrained()).toThrow('not_drained')
  expect(() => conn.forwardStreamLocal(client, '/other.sock', vi.fn())).toThrow('admission_closed')
  const channel = new EventEmitter()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock ssh2 client hands back this EventEmitter as its channel.
  accept!(undefined, channel as never)
  expect(received).toHaveBeenCalledWith(undefined, channel)
  expect(() => fence.assertDrained()).toThrow('not_drained')
  channel.emit('close')
  await fence.drain(new AbortController().signal)
  expect(client.openssh_forwardOutStreamLocal).toHaveBeenCalledOnce()
})

it('rejects stale clients and non-Unix endpoints before remote socket forwarding', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  const client = conn.getClient()!
  client.openssh_forwardOutStreamLocal = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in for a different ssh2 client; only its identity is compared.
  expect(() => conn.forwardStreamLocal({} as never, '/saved.sock', vi.fn())).toThrow(
    'client_changed'
  )
  for (const endpoint of ['relative.sock', '\\\\.\\pipe\\saved', '/saved\0.sock']) {
    expect(() => conn.forwardStreamLocal(client, endpoint, vi.fn())).toThrow('endpoint_invalid')
  }
  expect(client.openssh_forwardOutStreamLocal).not.toHaveBeenCalled()
})

it('does not treat an uncertain remote socket open as drained', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  const client = conn.getClient()!
  client.openssh_forwardOutStreamLocal = vi.fn(() => {
    throw new Error('uncertain-open')
  })
  expect(() => conn.forwardStreamLocal(client, '/saved.sock', vi.fn())).toThrow('uncertain-open')
  const fence = fenceSshConnectionWork(conn)
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('uncertain-open')
})

it('surfaces remote socket extension refusal without a fallback', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  const client = conn.getClient()!
  let accept: Parameters<typeof client.openssh_forwardOutStreamLocal>[1] | undefined
  client.openssh_forwardOutStreamLocal = vi.fn((_path, callback) => {
    accept = callback
    return client
  })
  const received = vi.fn()
  conn.forwardStreamLocal(client, '/saved.sock', received)
  const fence = fenceSshConnectionWork(conn)
  const refused = new Error('extension unsupported')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh2 passes no channel on a refused open; the callback type omits that case.
  accept!(refused, undefined as never)
  expect(received).toHaveBeenCalledWith(refused, undefined)
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('extension unsupported')
  expect(client.openssh_forwardOutStreamLocal).toHaveBeenCalledOnce()
})

it('retains remote socket channel errors through physical close', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  const client = conn.getClient()!
  const channel = new EventEmitter()
  client.openssh_forwardOutStreamLocal = vi.fn((_path, callback) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock ssh2 client hands back this EventEmitter as its channel.
    callback(undefined, channel as never)
    return client
  })
  conn.forwardStreamLocal(client, '/saved.sock', vi.fn())
  const fence = fenceSshConnectionWork(conn)
  channel.emit('error', new Error('connection lost'))
  channel.emit('close')
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('connection lost')
})

it('keeps the upload session SFTP channel tracked after logical close', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  ssh2Mock.sftpBehavior = 'pending'
  const opening = conn.openFileUploadSession()
  const fence = fenceSshConnectionWork(conn)
  const channel = Object.assign(new EventEmitter(), { end: vi.fn() })
  pendingSftpCallback?.(undefined, channel)
  const session = await opening
  session.close()
  expect(channel.end).toHaveBeenCalledOnce()
  expect(() => fence.assertDrained()).toThrow('not_drained')
  channel.emit('close')
  await fence.drain(new AbortController().signal)
  fence.assertDrained()
})

it('accounts for an SFTP open begun before fencing until its channel physically closes', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  ssh2Mock.sftpBehavior = 'pending'
  const opening = conn.sftp()
  const fence = fenceSshConnectionWork(conn)
  const done = vi.fn()
  const draining = fence.drain(new AbortController().signal).then(done)
  const channel = Object.assign(new EventEmitter(), { end: vi.fn() })
  pendingSftpCallback?.(undefined, channel)
  await opening
  expect(done).not.toHaveBeenCalled()
  expect(channel.end).not.toHaveBeenCalled()
  await expect(conn.sftp()).rejects.toThrow('admission_closed')
  channel.emit('close')
  await draining
  fence.assertDrained()
})

it('retains an opening timeout as unverifiable and never force-closes it to make drain pass', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  ssh2Mock.sftpBehavior = 'pending'
  vi.useFakeTimers()
  try {
    const opening = conn.sftp().catch((error: unknown) => error)
    const fence = fenceSshConnectionWork(conn)
    const draining = expect(fence.drain(new AbortController().signal)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30_000)
    await opening
    await draining
    await expect(fence.drain(new AbortController().signal)).rejects.toThrow('timed out')
    expect(conn.getState().status).toBe('connected')
  } finally {
    vi.useRealTimers()
  }
})
