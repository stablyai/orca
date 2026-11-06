import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resetSsh2ClientState } from '../__tests__/ssh-connection-test-client'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnectionManager } from './ssh-connection-manager'

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

describe('SshConnectionManager', () => {
  beforeEach(() => {
    resetSsh2ClientState()
  })

  it('does not erase a replacement registered while an admitted disconnect settles', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget({ id: 'target' })
    const old = await mgr.connect(target)
    const state = old.getState()
    vi.spyOn(old, 'getState').mockReturnValue({ ...state, status: 'disconnected' })
    let finish!: () => void
    vi.spyOn(old, 'disconnect')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue(undefined)
    const drain = mgr.disconnectAll()
    const replacement = await mgr.connect(target)
    expect(replacement).not.toBe(old)
    finish()
    await drain
    expect(mgr.getConnection('target')).toBe(replacement)
    await mgr.disconnectAll()
  })
})
