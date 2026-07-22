import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { createMockDeps } from './ssh-relay-session-test-fixtures'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const { muxRequestMock, registerSshPtyProviderMock, deployAndLaunchRelayMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  registerSshPtyProviderMock: vi.fn(),
  deployAndLaunchRelayMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: deployAndLaunchRelayMock }))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    request = muxRequestMock
    notify = vi.fn()
    onNotification = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: () => false,
  isSshPtyIdentityMismatchError: () => false,
  SshPtyProvider: class MockSshPtyProvider {
    constructor(
      readonly connectionId: string,
      readonly mux: unknown,
      readonly remoteCliBridgeEnv?: Record<string, unknown>
    ) {}
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({ SshGitProvider: class MockSshGitProvider {} }))
vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: registerSshPtyProviderMock,
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn(),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  answerStartupTerminalColorQueriesForPty: vi.fn((_id: string, data: string) => data)
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
vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: vi.fn()
}))

const { SshRelaySession } = await import('./ssh-relay-session')

describe('SSH relay CLI launcher registration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '0'
    deployAndLaunchRelayMock.mockResolvedValue({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      platform: 'linux-x64',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/orca',
      remoteRelayDir: '/home/orca/.orca-remote/relay-v1',
      nodePath: '/usr/bin/node',
      sockPath: '/home/orca/.orca-remote/relay-v1/relay.sock'
    })
  })

  it('installs and proves the launcher through the existing relay mux', async () => {
    muxRequestMock.mockImplementation(async (method: string) =>
      method === 'agent.execNonInteractive'
        ? {
            exitCode: 0,
            timedOut: false,
            stdout: '{"app":{"running":true},"runtime":{"reachable":true}}'
          }
        : { resolvedPath: '/home/orca' }
    )
    const rawWriteFile = vi.fn()
    const rawSftp = vi.fn()
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const connection = { writeFile: rawWriteFile, sftp: rawSftp } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(connection)

    expect(muxRequestMock).toHaveBeenCalledWith('fs.createDir', {
      dirPath: '/home/orca/.orca-relay/bin'
    })
    expect(muxRequestMock.mock.calls.filter(([method]) => method === 'fs.writeFile')).toHaveLength(
      2
    )
    const steps = muxRequestMock.mock.calls.filter(
      ([method, params]) =>
        method === 'agent.execNonInteractive' && params.operation === 'ssh-cli-launcher-install'
    )
    expect(steps.map(([, params]) => params.binary)).toEqual(['chmod', 'mv', 'mv'])
    expect(muxRequestMock).toHaveBeenCalledWith('agent.execNonInteractive', {
      binary: '/home/orca/.orca-relay/bin/orca-relay',
      args: ['status', '--json'],
      env: {
        ORCA_RELAY_NODE_PATH: '/usr/bin/node',
        ORCA_RELAY_DIR: '/home/orca/.orca-remote/relay-v1',
        ORCA_RELAY_SOCKET_PATH: '/home/orca/.orca-remote/relay-v1/relay.sock'
      },
      operation: 'ssh-cli-launcher-probe',
      timeoutMs: 30_000
    })
    expect(rawWriteFile).not.toHaveBeenCalled()
    expect(rawSftp).not.toHaveBeenCalled()
    const provider = registerSshPtyProviderMock.mock.calls[0]?.[1] as {
      remoteCliBridgeEnv?: Record<string, unknown>
    }
    expect(provider.remoteCliBridgeEnv?.orchestrationLauncherPath).toBe(
      '/home/orca/.orca-relay/bin/orca-relay'
    )
  })

  it('keeps terminal access but withholds capability when launcher install fails', async () => {
    muxRequestMock.mockImplementation(async (method: string) =>
      method === 'agent.execNonInteractive'
        ? { exitCode: 126, timedOut: false, stderr: 'chmod denied' }
        : { resolvedPath: '/home/orca' }
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(session.getState()).toBe('ready')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chmod denied'))
    const provider = registerSshPtyProviderMock.mock.calls[0]?.[1] as {
      remoteCliBridgeEnv?: Record<string, unknown>
    }
    expect(provider.remoteCliBridgeEnv?.orchestrationLauncherPath).toBeUndefined()
    warn.mockRestore()
  })

  it('reuses an existing launcher when a reconnect-time reinstall fails', async () => {
    muxRequestMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'agent.execNonInteractive') {
        return { resolvedPath: '/home/orca' }
      }
      return params.operation === 'ssh-cli-launcher-probe'
        ? {
            exitCode: 0,
            timedOut: false,
            stdout: '{"ok":true,"result":{"app":{"running":true},"runtime":{"reachable":true}}}'
          }
        : { exitCode: 1, timedOut: false, stderr: 'transient install failure' }
    })
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    const provider = registerSshPtyProviderMock.mock.calls[0]?.[1] as {
      remoteCliBridgeEnv?: Record<string, unknown>
    }
    expect(provider.remoteCliBridgeEnv?.orchestrationLauncherPath).toBe(
      '/home/orca/.orca-relay/bin/orca-relay'
    )
    expect(muxRequestMock.mock.calls.filter(([method]) => method === 'fs.deletePath')).toHaveLength(
      2
    )
  })

  it('withholds capability when an executable does not reach the Orca runtime', async () => {
    muxRequestMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'agent.execNonInteractive') {
        return { resolvedPath: '/home/orca' }
      }
      return params.operation === 'ssh-cli-launcher-probe'
        ? { exitCode: 0, timedOut: false, stdout: '' }
        : { exitCode: 0, timedOut: false }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    const provider = registerSshPtyProviderMock.mock.calls[0]?.[1] as {
      remoteCliBridgeEnv?: Record<string, unknown>
    }
    expect(provider.remoteCliBridgeEnv?.orchestrationLauncherPath).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid Orca status response'))
    warn.mockRestore()
  })

  it('compiles the Windows launcher through the relay without a cmd.exe shim', async () => {
    deployAndLaunchRelayMock.mockResolvedValueOnce({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      platform: 'win32-x64',
      hostPlatform: getRemoteHostPlatform('win32-x64'),
      remoteHome: 'C:/Users/me',
      remoteRelayDir: 'C:/Users/me/.orca-remote/relay-v1',
      nodePath: 'C:/Program Files/nodejs/node.exe',
      sockPath: '\\\\.\\pipe\\orca-relay-123'
    })
    muxRequestMock.mockImplementation(async (method: string) =>
      method === 'agent.execNonInteractive'
        ? {
            exitCode: 0,
            timedOut: false,
            stdout: '{"app":{"running":true},"runtime":{"reachable":true}}'
          }
        : { resolvedPath: 'C:/Users/me' }
    )
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const rawWriteFile = vi.fn()
    const connection = { writeFile: rawWriteFile } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(connection)

    expect(rawWriteFile).not.toHaveBeenCalled()
    const writes = muxRequestMock.mock.calls.filter(([method]) => method === 'fs.writeFile')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[1]?.filePath).toMatch(
      /^C:\/Users\/me\/\.orca-relay\/bin\/orca-launcher-[a-f0-9]+\.cs$/
    )
    const launcherSource = writes[0]?.[1]?.content as string
    expect(launcherSource).toContain('ORCA_RELAY_SOCKET_PATH')
    expect(launcherSource).not.toContain('cmd.exe')
    expect(launcherSource).not.toContain('%*')
    const install = muxRequestMock.mock.calls.find(
      ([method, params]) =>
        method === 'agent.execNonInteractive' && params.operation === 'ssh-cli-launcher-install'
    )
    expect(install?.[1]).toMatchObject({
      binary: 'powershell.exe',
      operation: 'ssh-cli-launcher-install'
    })
    const args = install?.[1]?.args as string[]
    const encoded = args[args.indexOf('-EncodedCommand') + 1]
    const script = Buffer.from(encoded!, 'base64').toString('utf16le')
    expect(script).toContain('csc.exe')
    expect(script).toContain("-Destination 'C:/Users/me/.orca-relay/bin/orca-relay.exe'")
    expect(script).not.toContain('cmd.exe')
  })
})
