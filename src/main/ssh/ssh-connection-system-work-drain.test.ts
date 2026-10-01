import { beforeEach, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import {
  createCallbacks,
  createResolvedConfig,
  createTarget,
  fenceSshConnectionWork
} from './ssh-connection-test-fixtures'
import { resetSshConnectionMocks } from './ssh-connection-test-harness'
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

it('holds an admitted system upload session across reset until close and uploads settle', async () => {
  vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
  const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
  await conn.connect()
  const session = await conn.openFileUploadSession()
  const fence = fenceSshConnectionWork(conn)
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
    const fence = fenceSshConnectionWork(conn)
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
