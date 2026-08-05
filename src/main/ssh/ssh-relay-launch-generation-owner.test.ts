import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/mock/app' } }))
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))
vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn((os: string) =>
    os.toLowerCase() === 'linux' ? 'linux-x64' : null
  ),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))
vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))
vi.mock('./ssh-relay-endpoint-credential', () => ({
  writeRelayEndpointCredential: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))
vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), { name: 'AbortError' })
}))
vi.mock('./ssh-relay-poll-delay', () => ({
  waitForRelayPollDelay: vi.fn().mockResolvedValue(undefined)
}))

import { serializeRelayOwnerManifest } from '../../shared/relay-owner-manifest'
import type { SshConnection } from './ssh-connection'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'

const REMOTE_DIR = '/home/user/.orca-remote/relay-0.1.0+abcdef012345'
const SOCK = `${REMOTE_DIR}/relay.sock`
const GENERATION_PATTERN = /--owner-token '([0-9a-f]{64})'/
const SOCK_IDENTITY = '2049:999:1785948267'
const OCCUPIED_PROBE =
  '__ORCA_RELAY_OWNER__\nsockid=unusable\nmanifest=missing\n__ORCA_RELAY_OWNER_END__\n'

const mockExec = vi.mocked(execCommand)
const mockSentinel = vi.mocked(waitForSentinel)

function makeMockConnection(): SshConnection {
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sftp: vi.fn().mockResolvedValue({
      mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
      createWriteStream: vi.fn().mockReturnValue({
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') {
            setTimeout(cb, 0)
          }
        }),
        end: vi.fn()
      }),
      end: vi.fn()
    })
  } as unknown as SshConnection
}

const transport = { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() }

type HostScript = { socketAlive?: string; owner?: string; identity?: string[] }

function ownerOutput(generation: string): string {
  const manifest = serializeRelayOwnerManifest({
    generation,
    pid: 4321,
    socketPath: SOCK,
    socketDev: 2049,
    socketIno: 999,
    socketCtimeSeconds: 1785948267
  })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => `m:${line}`)
    .join('\n')
  return `__ORCA_RELAY_OWNER__\nsockid=${SOCK_IDENTITY}\nmanifest=present\n${manifest}\n__ORCA_RELAY_OWNER_END__\n`
}

function identityOutput(state: string, start = 'linux:99'): string {
  return `__ORCA_RELAY_OWNER_ID__\nstate=${state}\nstart=${start}\n__ORCA_RELAY_OWNER_ID_END__\n`
}

/** Routes the whole already-installed POSIX deploy against a scripted remote host. */
function installHost(script: HostScript): { commands: string[]; launchedGeneration: () => string } {
  const commands: string[] = []
  const identity = [...(script.identity ?? [identityOutput('match'), identityOutput('gone', '')])]
  let launchedGeneration = ''
  mockExec.mockImplementation((_conn, command: string) => {
    commands.push(command)
    const generationInLaunch = GENERATION_PATTERN.exec(command)
    if (generationInLaunch) {
      launchedGeneration = generationInLaunch[1]
    }
    if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
      return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    }
    if (command === 'echo $HOME') {
      return Promise.resolve('/home/user')
    }
    if (command.includes('ORCA-NATIVE')) {
      return Promise.resolve('ORCA-NATIVE-DEPS-OK')
    }
    if (command.includes('orca_claim=$(')) {
      return Promise.resolve('CREATED')
    }
    if (command.includes('.recovery-lock')) {
      return Promise.resolve('RELEASED')
    }
    if (command.includes('process.stdout.write("READY")')) {
      return Promise.resolve('READY')
    }
    if (command.includes('test -S')) {
      return Promise.resolve(script.socketAlive ?? 'ALIVE')
    }
    if (command.includes('__ORCA_RELAY_RELAUNCH_READY__')) {
      return Promise.resolve(
        '__ORCA_RELAY_RELAUNCH_READY__\nready=absent\n__ORCA_RELAY_RELAUNCH_READY_END__\n'
      )
    }
    if (command.includes('kill -TERM')) {
      return Promise.resolve(identityOutput('signalled'))
    }
    if (command.includes('__ORCA_RELAY_OWNER_ID__')) {
      // The last scripted reply repeats, so a single-entry script models a process that never changes.
      return Promise.resolve(
        (identity.length > 1 ? identity.shift() : identity[0]) ?? identityOutput('gone', '')
      )
    }
    if (command.includes('__ORCA_RELAY_OWNER__')) {
      return Promise.resolve(script.owner ?? ownerOutput('a'.repeat(64)))
    }
    return Promise.resolve('')
  })
  return { commands, launchedGeneration: () => launchedGeneration }
}

function detachedLaunches(conn: SshConnection): string[] {
  return vi
    .mocked(conn.exec)
    .mock.calls.map(([command]) => command as string)
    .filter((command) => command.includes('--detached'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockExec.mockReset()
  mockSentinel.mockReset().mockResolvedValue(transport)
})

describe('launchRelay generation ownership', () => {
  it('publishes a fresh generation token in the detached launch argv', async () => {
    const conn = makeMockConnection()
    const host = installHost({ socketAlive: 'DEAD' })

    await deployAndLaunchRelay(conn)

    const [launch] = detachedLaunches(conn)
    expect(launch).toMatch(GENERATION_PATTERN)
    expect(launch).toContain('--sock-path')
    expect(host.launchedGeneration()).toBe('')
  })

  it('mints a distinct generation token per launch', async () => {
    const tokens = new Set<string>()
    for (let attempt = 0; attempt < 3; attempt++) {
      vi.clearAllMocks()
      mockExec.mockReset()
      mockSentinel.mockReset().mockResolvedValue(transport)
      const conn = makeMockConnection()
      installHost({ socketAlive: 'DEAD' })
      await deployAndLaunchRelay(conn)
      tokens.add(GENERATION_PATTERN.exec(detachedLaunches(conn)[0])?.[1] ?? '')
    }
    expect(tokens.size).toBe(3)
  })

  it('never adds an owner token to the connect-mode command', async () => {
    const conn = makeMockConnection()
    installHost({ socketAlive: 'DEAD' })

    await deployAndLaunchRelay(conn)

    const connects = vi
      .mocked(conn.exec)
      .mock.calls.map(([command]) => command as string)
      .filter((command) => command.includes('--connect'))
    expect(connects.length).toBeGreaterThan(0)
    for (const command of connects) {
      expect(command).not.toContain('--owner-token')
    }
  })
})

describe('launchRelay reconnect recovery', () => {
  it('does nothing extra when the reconnect succeeds', async () => {
    const conn = makeMockConnection()
    const host = installHost({ socketAlive: 'ALIVE' })

    await deployAndLaunchRelay(conn)

    expect(host.commands.some((command) => command.includes('kill -TERM'))).toBe(false)
    expect(host.commands.some((command) => command.includes('rm -f'))).toBe(false)
    expect(host.commands.some((command) => command.includes('__ORCA_RELAY_OWNER__'))).toBe(false)
    expect(detachedLaunches(conn)).toHaveLength(0)
  })

  it('terminates the proven owner once and relaunches once when the reconnect fails', async () => {
    const conn = makeMockConnection()
    const host = installHost({ socketAlive: 'ALIVE' })
    mockSentinel.mockRejectedValueOnce(new Error('stale relay reconnect failed'))

    await deployAndLaunchRelay(conn)

    expect(host.commands.filter((command) => command.includes('kill -TERM'))).toHaveLength(1)
    expect(detachedLaunches(conn)).toHaveLength(1)
  })

  it('never bare-unlinks the socket of a relay it could not prove it owns', async () => {
    const conn = makeMockConnection()
    const host = installHost({
      socketAlive: 'ALIVE',
      owner: `__ORCA_RELAY_OWNER__\nsockid=${SOCK_IDENTITY}\nmanifest=missing\n__ORCA_RELAY_OWNER_END__\n`
    })
    mockSentinel.mockRejectedValueOnce(new Error('stale relay reconnect failed'))

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/relay/i)

    expect(host.commands.some((command) => command.includes('kill'))).toBe(false)
    expect(
      host.commands.some((command) => command.includes('rm -f') && command.includes('relay.sock'))
    ).toBe(false)
    expect(detachedLaunches(conn)).toHaveLength(0)
  })

  it('does not relaunch when the owner survives termination', async () => {
    const conn = makeMockConnection()
    const host = installHost({ socketAlive: 'ALIVE', identity: [identityOutput('match')] })
    mockSentinel.mockRejectedValueOnce(new Error('stale relay reconnect failed'))

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/relay/i)

    expect(detachedLaunches(conn)).toHaveLength(0)
    expect(host.commands.some((command) => command.includes('__ORCA_RELAY_OWNER_CLEANUP__'))).toBe(
      false
    )
  })

  it('surfaces a relaunch failure instead of launching a second time', async () => {
    const conn = makeMockConnection()
    const host = installHost({ socketAlive: 'ALIVE' })
    const routed = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      if (command.includes('process.stdout.write("READY")')) {
        return Promise.resolve('WAITING')
      }
      return (routed as NonNullable<typeof routed>)(c, command, options)
    })
    mockSentinel.mockRejectedValueOnce(new Error('stale relay reconnect failed'))

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/failed to start/i)

    expect(detachedLaunches(conn)).toHaveLength(1)
    expect(host.commands.filter((command) => command.includes('kill -TERM'))).toHaveLength(1)
  }, 30_000)

  it('never blind-launches when a transport fault hides an unprovable relay', async () => {
    const conn = makeMockConnection()
    const host = installHost({
      owner: `__ORCA_RELAY_OWNER__\nsockid=${SOCK_IDENTITY}\nmanifest=missing\n__ORCA_RELAY_OWNER_END__\n`
    })
    const routed = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      // A plain (confirmed) transport error on the liveness probe used to fall through to a fresh
      // launch — over a relay that may still be alive with PTYs.
      if (command.includes('test -S') && !command.includes('__ORCA_RELAY_OWNER__')) {
        return Promise.reject(new Error('ssh channel refused'))
      }
      return (routed as NonNullable<typeof routed>)(c, command, options)
    })

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/relay socket/i)

    expect(detachedLaunches(conn)).toHaveLength(0)
    expect(host.commands.some((command) => command.includes('kill'))).toBe(false)
  })

  it('refuses a non-socket at the endpoint path instead of launching over it', async () => {
    // Why: `test -S` is false for a plain file or a symlink too, and collapsing those into DEAD sent
    // them to a blind fresh launch that rotates the endpoint credential.
    const conn = makeMockConnection()
    const host = installHost({ socketAlive: 'OCCUPIED', owner: OCCUPIED_PROBE })

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/not a socket/i)

    expect(detachedLaunches(conn)).toHaveLength(0)
    expect(host.commands.some((command) => command.includes('kill'))).toBe(false)
  })

  it('rethrows an unconfirmed SSH termination raised during recovery', async () => {
    const conn = makeMockConnection()
    const unconfirmed = Object.assign(new Error('owner probe still running'), {
      sshChannelCloseConfirmed: false
    })
    installHost({ socketAlive: 'ALIVE' })
    const routed = mockExec.getMockImplementation()
    mockExec.mockImplementation((c, command: string, options) => {
      if (command.includes('__ORCA_RELAY_OWNER__')) {
        return Promise.reject(unconfirmed)
      }
      return (routed as NonNullable<typeof routed>)(c, command, options)
    })
    mockSentinel.mockRejectedValueOnce(new Error('stale relay reconnect failed'))

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(unconfirmed)
    expect(detachedLaunches(conn)).toHaveLength(0)
  })
})
