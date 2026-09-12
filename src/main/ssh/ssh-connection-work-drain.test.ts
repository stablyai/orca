import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import {
  resetSshConnectionMocks,
  pendingSftpCallback,
  ssh2Mock
} from './ssh-connection-test-harness'
import { resolveWithSshG } from './ssh-config-parser'
import {
  downloadFileViaSystemSsh,
  uploadDirectoryViaSystemSsh,
  uploadFileViaSystemSsh,
  writeFileViaSystemSsh,
  writeBufferViaSystemSsh
} from './ssh-system-fallback'

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
  const fence = conn.fenceWorkForReset()
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
    callback?.(undefined, channel as never)
    return client
  })
  conn.forwardOut(client, socket, '127.0.0.1', 0, 'remote', 443, vi.fn())
  const fence = conn.fenceWorkForReset()
  expect(() =>
    conn.forwardOut(client, new EventEmitter(), '127.0.0.1', 0, 'remote', 443, vi.fn())
  ).toThrow('admission_closed')
  expect(() =>
    conn.forwardOut({} as never, new EventEmitter(), '127.0.0.1', 0, 'remote', 443, vi.fn())
  ).toThrow('client_changed')
  channel.emit('close')
  expect(() => fence.assertDrained()).toThrow('not_drained')
  socket.emit('close')
  await fence.drain(new AbortController().signal)
  expect(client.forwardOut).toHaveBeenCalledOnce()
})

it('holds an admitted system upload session across reset until close and uploads settle', async () => {
  vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
  const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
  await conn.connect()
  const session = await conn.openFileUploadSession()
  const fence = conn.fenceWorkForReset()
  await expect(conn.openFileUploadSession()).rejects.toThrow('admission_closed')
  await session.uploadFile('/first', '/remote-first')
  const pending = Promise.withResolvers<void>()
  vi.mocked(uploadFileViaSystemSsh).mockReturnValueOnce(pending.promise)
  const upload = session.uploadFile('/second', '/remote-second')
  session.close()
  await expect(session.uploadFile('/third', '/remote-third')).rejects.toThrow('session_closed')
  expect(() => fence.assertDrained()).toThrow('not_drained')
  const draining = fence.drain(new AbortController().signal)
  expect(conn.getState().status).toBe('connected')
  pending.resolve()
  await upload
  await draining
  fence.assertDrained()
  expect(uploadFileViaSystemSsh).toHaveBeenCalledTimes(2)
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
  const fence = conn.fenceWorkForReset()
  expect(() => fence.assertDrained()).toThrow('not_drained')
  expect(() => conn.forwardStreamLocal(client, '/other.sock', vi.fn())).toThrow('admission_closed')
  const channel = new EventEmitter()
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
  const fence = conn.fenceWorkForReset()
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
  const fence = conn.fenceWorkForReset()
  const refused = new Error('extension unsupported')
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
    callback(undefined, channel as never)
    return client
  })
  conn.forwardStreamLocal(client, '/saved.sock', vi.fn())
  const fence = conn.fenceWorkForReset()
  channel.emit('error', new Error('connection lost'))
  channel.emit('close')
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('connection lost')
})

it('keeps the upload session SFTP channel tracked after logical close', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  ssh2Mock.sftpBehavior = 'pending'
  const opening = conn.openFileUploadSession()
  const fence = conn.fenceWorkForReset()
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

it.each(['download', 'upload', 'writeFile', 'writeBuffer'])(
  'drains the whole admitted system SSH %s without canceling it',
  async (kind) => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
    await conn.connect()
    const pending = Promise.withResolvers<void>()
    const invoke = () => {
      if (kind === 'download') {
        return conn.downloadFile('/remote', '/local')
      }
      if (kind === 'upload') {
        return conn.uploadDirectory('/local', '/remote')
      }
      if (kind === 'writeFile') {
        return conn.writeFile('/remote', 'text')
      }
      return conn.writeBuffer('/remote', Buffer.from('bytes'))
    }
    const operation =
      kind === 'download'
        ? downloadFileViaSystemSsh
        : kind === 'upload'
          ? uploadDirectoryViaSystemSsh
          : kind === 'writeFile'
            ? writeFileViaSystemSsh
            : writeBufferViaSystemSsh
    vi.mocked(operation).mockReturnValueOnce(pending.promise)
    const running = invoke()
    const fence = conn.fenceWorkForReset()
    const done = vi.fn()
    const draining = fence.drain(new AbortController().signal).then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    await expect(invoke()).rejects.toThrow('admission_closed')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(conn.getState().status).toBe('connected')
    pending.resolve()
    await running
    await draining
    fence.assertDrained()
  }
)

it('accounts for an SFTP open begun before fencing until its channel physically closes', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  ssh2Mock.sftpBehavior = 'pending'
  const opening = conn.sftp()
  const fence = conn.fenceWorkForReset()
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
    const fence = conn.fenceWorkForReset()
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
