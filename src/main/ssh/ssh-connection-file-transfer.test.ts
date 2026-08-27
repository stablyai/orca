import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resetSshConnectionMocks } from './ssh-connection-test-harness'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from './ssh-config-parser'
import {
  downloadFileViaSystemSsh,
  uploadDirectoryViaSystemSsh,
  uploadFileViaSystemSsh,
  writeBufferViaSystemSsh,
  writeFileViaSystemSsh
} from './ssh-system-fallback'
import { getRemoteHostPlatform } from './ssh-remote-platform'

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

describe('SshConnection', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  it('passes the detected host platform to system SSH file operations', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
    const hostPlatform = getRemoteHostPlatform('win32-x64')

    await conn.connect()
    await conn.uploadDirectory('/tmp/local-relay', 'C:/Users/me/.orca-remote/relay', {
      hostPlatform
    })
    await conn.writeFile('C:/Users/me/.orca-remote/relay/.version', '0.1.0', {
      hostPlatform
    })
    await conn.writeBuffer('C:/Users/me/.orca-remote/relay/logo.png', Buffer.from('png'), {
      hostPlatform,
      exclusive: true
    })
    await conn.downloadFile('C:/Users/me/.orca-remote/relay/logo.png', '/tmp/logo.png', {
      hostPlatform
    })
    const uploadSession = await conn.openFileUploadSession({ hostPlatform })
    await uploadSession.uploadFile('/tmp/logo.png', 'C:/Users/me/project/logo.png', {
      exclusive: true
    })
    uploadSession.close()

    expect(uploadDirectoryViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      '/tmp/local-relay',
      'C:/Users/me/.orca-remote/relay',
      expect.objectContaining({
        hostPlatform,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(writeFileViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'C:/Users/me/.orca-remote/relay/.version',
      '0.1.0',
      expect.objectContaining({
        hostPlatform,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(writeBufferViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'C:/Users/me/.orca-remote/relay/logo.png',
      Buffer.from('png'),
      expect.objectContaining({
        hostPlatform,
        exclusive: true,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(downloadFileViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'C:/Users/me/.orca-remote/relay/logo.png',
      '/tmp/logo.png',
      expect.objectContaining({
        hostPlatform,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(uploadFileViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      '/tmp/logo.png',
      'C:/Users/me/project/logo.png',
      expect.objectContaining({
        hostPlatform,
        exclusive: true,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
  })

  it('composes a caller abort into system SSH relay uploads', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
    const controller = new AbortController()
    let transferSignal: AbortSignal | undefined
    vi.mocked(uploadDirectoryViaSystemSsh).mockImplementationOnce(
      (_target, _localDir, _remoteDir, options) => {
        transferSignal = options?.signal
        return new Promise((_resolve, reject) => {
          transferSignal?.addEventListener('abort', () => reject(transferSignal?.reason), {
            once: true
          })
        })
      }
    )

    await conn.connect()
    const upload = conn.uploadDirectory('/tmp/local-relay', '/remote/relay', {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(transferSignal).toBeDefined())
    controller.abort()

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' })
    expect(transferSignal?.aborted).toBe(true)
  })

  it('keeps connection disconnect cancellation linked to caller-scoped relay writes', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
    const controller = new AbortController()
    let transferSignal: AbortSignal | undefined
    vi.mocked(writeFileViaSystemSsh).mockImplementationOnce(
      (_target, _remotePath, _contents, options) => {
        transferSignal = options?.signal
        return new Promise((_resolve, reject) => {
          transferSignal?.addEventListener('abort', () => reject(transferSignal?.reason), {
            once: true
          })
        })
      }
    )

    await conn.connect()
    const write = conn.writeFile('/remote/relay/.version', '0.1.0', {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(transferSignal).toBeDefined())
    await conn.disconnect()

    await expect(write).rejects.toMatchObject({ name: 'AbortError' })
    expect(controller.signal.aborted).toBe(false)
    expect(transferSignal?.aborted).toBe(true)
  })

  it('keeps an upload session cancelled after the connection disconnects', async () => {
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )
    vi.mocked(uploadFileViaSystemSsh).mockImplementation(
      async (_target, _localPath, _remotePath, options) => {
        if (options?.signal?.aborted) {
          const error = new Error('System SSH operation was cancelled')
          error.name = 'AbortError'
          throw error
        }
      }
    )

    await conn.connect()
    const uploadSession = await conn.openFileUploadSession()
    await conn.disconnect()

    await expect(
      uploadSession.uploadFile('/tmp/late.txt', '/remote/late.txt')
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(uploadFileViaSystemSsh).toHaveBeenCalledWith(
      expect.anything(),
      '/tmp/late.txt',
      '/remote/late.txt',
      expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) })
    )
  })
})
