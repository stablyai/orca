import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import { createMockDeps } from './ssh-relay-session-test-fixtures'
import {
  RelayRuntimeLadderRun,
  RemoteRuntimeUnavailableError
} from './ssh-relay-runtime-resolution'
import { getSshPlainSshMode } from './ssh-plain-ssh-mode'
import { SshPlainShellPtyProvider } from '../providers/ssh-plain-shell-pty-provider'
import { SshSftpFilesystemProvider } from '../providers/ssh-sftp-filesystem-provider'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type * as IntakeRegistry from '../ipc/ssh-pty-output-intake-registry'

type IntakeRegistryModule = typeof IntakeRegistry

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))

vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn(),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn().mockReturnValue(true)
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

vi.mock('../ipc/ssh-pty-output-intake-registry', async (importOriginal) => ({
  ...(await importOriginal<IntakeRegistryModule>()),
  acceptSshPtyOutputData: vi.fn().mockResolvedValue({}),
  acceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
  closeSshPtyOutputGeneration: vi.fn()
}))

const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')
const pty = await import('../ipc/pty')
const fsDispatch = await import('../providers/ssh-filesystem-dispatch')
const intake = await import('../ipc/ssh-pty-output-intake-registry')

class FakeShellChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly write = vi.fn()
  readonly setWindow = vi.fn()
  readonly close = vi.fn()
}

function runtimeUnavailable(): RemoteRuntimeUnavailableError {
  const run = new RelayRuntimeLadderRun('target-1', null, true)
  run.host = getRemoteHostPlatform('linux-x64')
  run.refused('A', 'libc_floor')
  run.refused('C', 'host_node_missing')
  return new RemoteRuntimeUnavailableError(run)
}

function createConnection(systemSsh = false) {
  const channel = new FakeShellChannel()
  const conn = {
    usesSystemSshTransport: () => systemSsh,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeShellChannel implements every ClientChannel member the provider touches.
    shell: vi.fn(async () => channel as unknown as ClientChannel),
    sftp: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Plain SSH mode only calls usesSystemSshTransport, shell and sftp on the connection.
  return { conn: conn as unknown as SshConnection, channel, shell: conn.shell }
}

function registeredPlainProvider(): SshPlainShellPtyProvider {
  const provider = vi.mocked(pty.registerSshPtyProvider).mock.calls[0]?.[1]
  if (!(provider instanceof SshPlainShellPtyProvider)) {
    throw new Error('plain SSH PTY provider was not registered')
  }
  return provider
}

function createSession() {
  const deps = createMockDeps()
  const session = new SshRelaySession(
    'target-1',
    deps.getMainWindow,
    deps.mockStore,
    deps.mockPortForward
  )
  return { session, deps }
}

describe('SshRelaySession plain SSH mode (runtime rung D)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(deployAndLaunchRelay).mockRejectedValue(runtimeUnavailable())
  })

  it('connects with shell and SFTP providers and records the classified reason', async () => {
    const { session } = createSession()
    const onReady = vi.fn()
    session.setOnReady(onReady)
    const { conn } = createConnection()

    await session.establish(conn)

    expect(session.getState()).toBe('ready')
    expect(onReady).toHaveBeenCalledWith('target-1')
    expect(session.getMux()).toBeNull()
    expect(vi.mocked(pty.registerSshPtyProvider).mock.calls[0]?.[1]).toBeInstanceOf(
      SshPlainShellPtyProvider
    )
    expect(vi.mocked(fsDispatch.registerSshFilesystemProvider).mock.calls[0]?.[1]).toBeInstanceOf(
      SshSftpFilesystemProvider
    )
    expect(getSshPlainSshMode('target-1')).toMatchObject({ reason: 'no_runtime' })
    expect(getSshPlainSshMode('target-1')?.message).toContain('plain SSH terminals')
  })

  it('routes shell output and a proven exit through the SSH output intake', async () => {
    const { session, deps } = createSession()
    const { conn, channel, shell } = createConnection()
    await session.establish(conn)
    const provider = registeredPlainProvider()

    const { id } = await provider.spawn({ cols: 90, rows: 20 })
    expect(shell).toHaveBeenCalledWith({ cols: 90, rows: 20, term: 'xterm-256color' })
    channel.emit('data', Buffer.from('$ '))
    expect(intake.acceptSshPtyOutputData).toHaveBeenCalledWith(
      expect.objectContaining({ id, data: '$ ', rawLength: 2 })
    )

    channel.emit('exit', 0)
    channel.emit('close')
    await vi.waitFor(() =>
      expect(deps.mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
        'target-1',
        expect.stringContaining('plain-'),
        'terminated'
      )
    )
    expect(intake.acceptSshPtyOutputExit).toHaveBeenCalledWith(
      expect.objectContaining({ id, code: 0 })
    )
  })

  it('leaves open shells unverifiable when the session is torn down', async () => {
    const { session } = createSession()
    const { conn, channel } = createConnection()
    await session.establish(conn)
    const provider = registeredPlainProvider()
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    session.detach()
    channel.emit('close')

    expect(intake.acceptSshPtyOutputExit).not.toHaveBeenCalled()
    expect(intake.closeSshPtyOutputGeneration).toHaveBeenCalledWith(
      provider.providerGeneration,
      'connection_lost'
    )
    await expect(provider.probePtyLiveness(id)).resolves.toBeNull()
    expect(getSshPlainSshMode('target-1')).toBeUndefined()
  })

  it('lets only the current reconnect enter plain SSH mode', async () => {
    const { session } = createSession()
    const onReady = vi.fn()
    session.setOnReady(onReady)
    const { conn } = createConnection()
    await session.establish(conn)
    onReady.mockClear()
    vi.mocked(pty.registerSshPtyProvider).mockClear()

    let rejectStale: (error: Error) => void = () => {}
    vi.mocked(deployAndLaunchRelay).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectStale = reject))
    )
    const stale = session.reconnect(conn)
    await vi.waitFor(() => expect(deployAndLaunchRelay).toHaveBeenCalledTimes(2))
    const current = session.reconnect(conn)
    await current
    rejectStale(runtimeUnavailable())
    await stale

    expect(onReady).toHaveBeenCalledTimes(1)
    expect(pty.registerSshPtyProvider).toHaveBeenCalledTimes(1)
    expect(session.getPlainSshSession()).not.toBeNull()
    session.detach()
  })

  it('still fails the connect on system SSH, which has no shell or SFTP channel', async () => {
    const { session } = createSession()
    const { conn } = createConnection(true)

    await expect(session.establish(conn)).rejects.toBeInstanceOf(RemoteRuntimeUnavailableError)
    expect(pty.registerSshPtyProvider).not.toHaveBeenCalled()
    expect(getSshPlainSshMode('target-1')).toBeUndefined()
  })
})
