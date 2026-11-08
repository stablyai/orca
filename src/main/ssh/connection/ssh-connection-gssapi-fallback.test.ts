import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import 'node:fs'
import 'node:os'
import 'node:path'
import { ssh2Mock } from '../__tests__/ssh-connection-test-client'
import { resetSshConnectionMocks, spawnSystemSshCommandMock } from './ssh-connection-test-harness'
import {
  createCallbacks,
  createResolvedConfig,
  type createSystemCommandChannel,
  createTarget
} from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from '../config/ssh-g-config-resolution'

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

  it('keeps disconnected state when a disconnect cancels the reactive GSSAPI probe', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage = 'All configured authentication methods failed'
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ proxyUseFdpass: false, gssapiAuthentication: true })
    )
    // Hold the probe channel until disconnect bumps generation and closes it, exercising cancellation instead of failure.
    let pendingChannel: ReturnType<typeof createSystemCommandChannel> | null = null
    spawnSystemSshCommandMock.mockImplementation(() => {
      const channel = new EventEmitter() as ReturnType<typeof createSystemCommandChannel>
      channel.stdin = { end: vi.fn(), write: vi.fn() }
      channel.stderr = new EventEmitter()
      channel.close = vi.fn(() => channel.emit('close', null))
      pendingChannel = channel
      return channel
    })
    const onStateChange = vi.fn()
    const conn = new SshConnection(
      createTarget({ configHost: 'krb-host' }),
      createCallbacks({ onStateChange })
    )

    const connectPromise = conn.connect()
    // Wait until the reactive probe has spawned its (never-closing) channel.
    await vi.waitFor(() => expect(pendingChannel).not.toBeNull())

    await conn.disconnect()
    await connectPromise.catch(() => {})

    expect(conn.getState().status).toBe('disconnected')
    const statuses = onStateChange.mock.calls.map((call) => call[1].status)
    expect(statuses).not.toContain('auth-failed')
    expect(statuses).not.toContain('error')
  })
})
