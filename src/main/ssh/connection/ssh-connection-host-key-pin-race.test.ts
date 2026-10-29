import { expect, it, vi } from 'vitest'
import { clientInstances, ssh2Mock } from '../__tests__/ssh-connection-test-client'
import { resetSshConnectionMocks, spawnSystemSshCommandMock } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

vi.mock('ssh2', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2Module()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshCommandMocks(await importOriginal())
)
vi.mock('../ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)

const { installMock } = vi.hoisted(() => ({ installMock: vi.fn() }))
vi.mock('./ssh2-host-key-verification', () => ({
  installSsh2HostKeyVerification: installMock,
  readHostKeyTrustSources: vi.fn()
}))

it('keeps the current attempt pinned when a superseded attempt finishes its trust read later', async () => {
  resetSshConnectionMocks()
  ssh2Mock.connectBehavior = 'pending'
  let finishStaleRead: (value: unknown) => void = () => {}
  installMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishStaleRead = resolve
      })
  )
  installMock.mockResolvedValue({ rejection: null, pinnedByOrcaStore: true })
  const conn = new SshConnection(createTarget(), createCallbacks())
  const stale = conn.connect().catch(() => {})
  await vi.waitFor(() => expect(installMock).toHaveBeenCalledTimes(1))
  const current = conn.connect()
  await vi.waitFor(() => expect(clientInstances).toHaveLength(1))
  const currentClient = clientInstances[0]

  finishStaleRead({ rejection: null, pinnedByOrcaStore: true })
  await vi.waitFor(() => expect(clientInstances).toHaveLength(2))
  clientInstances[1].emit('error', new Error('stale attempt failed'))
  await stale
  currentClient.emit('error', new Error('Handshake failed: no matching host key format'))

  await expect(current).rejects.toThrow('no matching host key format')
  expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
})
