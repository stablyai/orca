import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clientInstances,
  emitSshEvent,
  eventHandlers,
  ssh2Mock
} from '../__tests__/ssh-connection-test-client'
import { resetSshConnectionMocks } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnectionManager } from './ssh-connection-manager'
import {
  recordSshCredentialDeclined,
  resetSshCredentialDeclinesForTests
} from '../ssh-credential-decline'

vi.mock('ssh2', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2Module()
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

const authFailure = (): Error => new Error('All configured authentication methods failed')

function lastConnectPassword(): unknown {
  const config = clientInstances.at(-1)?.lastConnectConfig
  return config && typeof config === 'object' && 'password' in config ? config.password : undefined
}

describe('SshConnectionManager on a password host', () => {
  const onCredentialRequest = vi.fn(async () => 'hunter2')
  let manager: SshConnectionManager

  beforeEach(async () => {
    resetSshConnectionMocks()
    resetSshCredentialDeclinesForTests()
    vi.stubEnv('SSH_AUTH_SOCK', '')
    onCredentialRequest.mockClear()
    manager = new SshConnectionManager(createCallbacks({ onCredentialRequest }))
    // The first sign-in: no key or agent, so the host refuses until the user types the password.
    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)
  })

  afterEach(async () => {
    await manager.disconnectAll()
  })

  it('does not ask again when a background dial lands while the dropped connection reconnects', async () => {
    const dropped = manager.getConnection('target-1')
    emitSshEvent('close')
    expect(dropped?.getState().status).toBe('reconnecting')

    ssh2Mock.connectSequence = ['ready']
    const replacement = await manager.connect(createTarget())

    expect(replacement).not.toBe(dropped)
    expect(replacement.getState().status).toBe('connected')
    expect(lastConnectPassword()).toBe('hunter2')
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)
  })

  it('does not ask again after a background owner closed the connection it opened', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)

    ssh2Mock.connectSequence = ['ready']
    await manager.connect(createTarget())

    expect(lastConnectPassword()).toBe('hunter2')
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)
    expect(manager.hasCachedCredential(createTarget())).toBe(true)
  })

  it('keeps the sign-in across a replacement that failed for a reason other than sign-in', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)
    ssh2Mock.connectSequence = [new Error('Handshake failed: signature verification failed')]
    await expect(manager.connect(createTarget())).rejects.toThrow('signature verification failed')

    ssh2Mock.connectSequence = ['ready']
    await manager.connect(createTarget())

    expect(lastConnectPassword()).toBe('hunter2')
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)
  })

  it('asks again, once, after the host refuses the remembered password', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)
    ssh2Mock.connectSequence = [authFailure()]
    await expect(manager.connect(createTarget())).rejects.toThrow('authentication methods failed')
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)

    onCredentialRequest.mockResolvedValueOnce('new-password')
    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())

    expect(onCredentialRequest).toHaveBeenCalledTimes(2)
    expect(lastConnectPassword()).toBe('new-password')
  })

  it('drops a remembered password the host re-asked for while a reconnect was signing in', async () => {
    ssh2Mock.connectSequence = ['silent']
    void manager.reconnect('target-1')
    await vi.waitFor(() =>
      expect(eventHandlers.get('keyboard-interactive')?.size ?? 0).toBeGreaterThan(0)
    )
    const passwordPrompt = [{ prompt: 'Password: ', echo: false }]
    const autoAnswered = vi.fn()
    emitSshEvent('keyboard-interactive', '', '', '', passwordPrompt, autoAnswered)
    await vi.waitFor(() => expect(autoAnswered).toHaveBeenCalledWith(['hunter2']))
    // The server asks again, so the remembered password was refused; the user has not answered yet.
    onCredentialRequest.mockImplementationOnce(() => new Promise(() => {}))
    emitSshEvent('keyboard-interactive', '', '', '', passwordPrompt, vi.fn())
    await vi.waitFor(() => expect(onCredentialRequest).toHaveBeenCalledTimes(2))
    // A background dial may not close the dialog the user is answering.
    await expect(manager.connect(createTarget())).rejects.toThrow('already in progress')
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)

    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())

    expect(onCredentialRequest).toHaveBeenCalledTimes(3)
  })

  it('does not hand on a typed password the host never accepted', async () => {
    await manager.disconnect('target-1')
    onCredentialRequest.mockResolvedValueOnce('typo')
    ssh2Mock.connectSequence = [
      authFailure(),
      new Error('Handshake failed: signature verification failed')
    ]
    await expect(manager.connect(createTarget())).rejects.toThrow('signature verification failed')
    expect(manager.hasCachedCredential(createTarget())).toBe(false)

    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())

    expect(onCredentialRequest).toHaveBeenCalledTimes(3)
  })

  it('keeps refusing background dials after the user cancelled a sign-in', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)
    recordSshCredentialDeclined('target-1')
    const clientsBefore = clientInstances.length

    await expect(manager.connect(createTarget())).rejects.toThrow('was cancelled')
    expect(clientInstances).toHaveLength(clientsBefore)
  })

  it('asks again when the host was edited to point somewhere else', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)
    const edited = createTarget({ host: 'other.example.com' })
    expect(manager.hasCachedCredential(edited)).toBe(false)

    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(edited)

    expect(onCredentialRequest).toHaveBeenCalledTimes(2)
  })

  it('forgets the sign-in when the user disconnects', async () => {
    await manager.disconnect('target-1')
    expect(manager.hasCachedCredential(createTarget())).toBe(false)

    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())

    expect(onCredentialRequest).toHaveBeenCalledTimes(2)
  })
})
