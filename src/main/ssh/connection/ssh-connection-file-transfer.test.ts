import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resetSshConnectionMocks } from './ssh-connection-test-harness'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from '../config/ssh-g-config-resolution'

import {
  uploadDirectoryViaSystemSsh,
  writeFileViaSystemSsh
} from '../system-transport/system-ssh-file-transfer'

vi.mock('../ssh2-module-load', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2LoaderModule()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-args', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshArgsMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshCommandMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-file-binary-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/system-ssh-file-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileTransferMocks(
    await importOriginal()
  )
)
vi.mock('../ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)

describe('SshConnection', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
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
})
