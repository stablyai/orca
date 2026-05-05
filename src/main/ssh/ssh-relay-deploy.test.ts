import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn()
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  execCommand: vi.fn().mockResolvedValue('Linux x86_64'),
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'

function makeMockConnection(): SshConnection {
  return {
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    sftp: vi.fn().mockResolvedValue({
      mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
      createWriteStream: vi.fn().mockReturnValue({
        on: vi.fn((_event: string, cb: () => void) => {
          if (_event === 'close') {
            setTimeout(cb, 0)
          }
        }),
        end: vi.fn()
      }),
      end: vi.fn()
    })
  } as unknown as SshConnection
}

describe('deployAndLaunchRelay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls exec to detect remote platform', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('Linux x86_64') // uname -sm
    mockExecCommand.mockResolvedValueOnce('/home/user') // echo $HOME
    mockExecCommand.mockResolvedValueOnce('OK') // check relay exists
    mockExecCommand.mockResolvedValueOnce('0.1.0') // version check
    mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    await deployAndLaunchRelay(conn)

    expect(mockExecCommand).toHaveBeenCalledWith(conn, 'uname -sm')
  })

  it('reports progress via callback', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('OK')
    mockExecCommand.mockResolvedValueOnce('0.1.0')
    mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    const progress: string[] = []
    await deployAndLaunchRelay(conn, (status) => progress.push(status))

    expect(progress).toContain('Detecting remote platform...')
    expect(progress).toContain('Starting relay...')
  })

  it('has a 120-second overall timeout', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)

    // Make the first exec never resolve
    mockExecCommand.mockReturnValueOnce(new Promise(() => {}))

    vi.useFakeTimers()

    // Catch the rejection immediately to avoid unhandled rejection warning
    const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)

    await vi.advanceTimersByTimeAsync(121_000)

    const result = await promise
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe('Relay deployment timed out after 120s')

    vi.useRealTimers()
  })

  it('uses distinct target-specific relay socket paths', async () => {
    const connA = makeMockConnection()
    const connB = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand
      .mockResolvedValueOnce('Linux x86_64') // uname A
      .mockResolvedValueOnce('/home/user') // $HOME A
      .mockResolvedValueOnce('OK') // exists A
      .mockResolvedValueOnce('0.1.0') // version A
      .mockResolvedValueOnce('DEAD') // probe A
      .mockResolvedValueOnce('READY') // poll A
      .mockResolvedValueOnce('Linux x86_64') // uname B
      .mockResolvedValueOnce('/home/user') // $HOME B
      .mockResolvedValueOnce('OK') // exists B
      .mockResolvedValueOnce('0.1.0') // version B
      .mockResolvedValueOnce('DEAD') // probe B
      .mockResolvedValueOnce('READY') // poll B

    await deployAndLaunchRelay(connA, undefined, 300, 'target-a')
    await deployAndLaunchRelay(connB, undefined, 300, 'target-b')

    const probeCommands = mockExecCommand.mock.calls
      .map(([, command]) => command)
      .filter(
        (command) =>
          command.includes('test -S') && command.includes('relay-') && command.includes('ALIVE')
      )
    expect(probeCommands).toHaveLength(2)
    expect(probeCommands[0]).toContain('relay-')
    expect(probeCommands[0]).not.toContain('relay.sock')
    expect(probeCommands[1]).toContain('relay-')
    expect(probeCommands[1]).not.toContain('relay.sock')
    expect(probeCommands[0]).not.toEqual(probeCommands[1])

    const launchA = vi.mocked(connA.exec).mock.calls.at(-1)?.[0] ?? ''
    const launchB = vi.mocked(connB.exec).mock.calls.at(-1)?.[0] ?? ''
    expect(launchA).toContain('--sock-path')
    expect(launchB).toContain('--sock-path')
    expect(launchA).not.toEqual(launchB)
  })
})
