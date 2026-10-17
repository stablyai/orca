import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isLegacyPermissionStatusProbe,
  readLaunchdChildHelperProcesses,
  sweepLegacyPermissionStatusProbes
} from './macos-legacy-permission-probe-sweep'

const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

const tmpRoot = '/var/folders/gj/abc_def/T'
const uid = 501
const helper =
  '/Applications/Orca.app/Contents/Resources/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
const leakedCommand = `${helper} --permission-status-file ${tmpRoot}/orca-computer-use-permissions-jNDXEZ/status.json`

function row(
  command: string,
  overrides: { pid?: number; parentPid?: number; uid?: number; executable?: string } = {}
) {
  return { pid: 4242, parentPid: 1, uid, executable: helper, command, ...overrides }
}

describe('isLegacyPermissionStatusProbe', () => {
  it('matches a leaked status probe under this user temp directory', () => {
    expect(isLegacyPermissionStatusProbe(row(leakedCommand), tmpRoot, uid)).toBe(true)
  })

  it('matches a dev-build helper bundle', () => {
    const devHelper =
      '/Users/me/orca/native/computer-use-macos/.build/release/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
    const command = `${devHelper} --permission-status-file ${tmpRoot}/orca-computer-use-permissions-a1B2c3/status.json`
    expect(
      isLegacyPermissionStatusProbe(row(command, { executable: devHelper }), tmpRoot, uid)
    ).toBe(true)
  })

  it.each([
    ['setup window for one permission', `${helper} --permission accessibility`],
    ['setup window', `${helper} --permissions`],
    [
      'computer-use provider',
      `${helper} --agent ${tmpRoot}/orca-computer-use-x/provider.sock --token-file ${tmpRoot}/orca-computer-use-x/provider.token`
    ],
    [
      'another temp directory',
      `${helper} --permission-status-file /var/folders/zz/other/T/orca-computer-use-permissions-jNDXEZ/status.json`
    ],
    [
      'a different file name',
      `${helper} --permission-status-file ${tmpRoot}/orca-computer-use-permissions-jNDXEZ/other.json`
    ],
    [
      'a nested path',
      `${helper} --permission-status-file ${tmpRoot}/orca-computer-use-permissions-jNDXEZ/x/status.json`
    ],
    ['trailing arguments', `${leakedCommand} --extra`]
  ])('ignores %s', (_label, command) => {
    expect(isLegacyPermissionStatusProbe(row(command), tmpRoot, uid)).toBe(false)
  })

  it.each([
    ['a different binary', '/Applications/Other.app/Contents/MacOS/other'],
    ['a process that only mentions the probe in its arguments', '/usr/bin/grep'],
    ['a relative helper path', 'orca-computer-use-macos'],
    ['a helper outside an app bundle', '/tmp/orca-computer-use-macos']
  ])('ignores %s', (_label, executable) => {
    const command = `${executable} ${leakedCommand.slice(helper.length + 1)}`
    expect(isLegacyPermissionStatusProbe(row(command, { executable }), tmpRoot, uid)).toBe(false)
    expect(
      isLegacyPermissionStatusProbe(
        row(`${executable} ${leakedCommand}`, { executable }),
        tmpRoot,
        uid
      )
    ).toBe(false)
  })

  it('ignores another user and processes not launched by launchd', () => {
    expect(isLegacyPermissionStatusProbe(row(leakedCommand, { uid: 502 }), tmpRoot, uid)).toBe(
      false
    )
    expect(
      isLegacyPermissionStatusProbe(row(leakedCommand, { parentPid: 999 }), tmpRoot, uid)
    ).toBe(false)
  })

  it('treats temp directory characters literally', () => {
    const command = `${helper} --permission-status-file /var/folders/gj/abcXdef/T/orca-computer-use-permissions-jNDXEZ/status.json`
    expect(isLegacyPermissionStatusProbe(row(command), '/var/folders/gj/abc.def/T', uid)).toBe(
      false
    )
  })
})

describe('sweepLegacyPermissionStatusProbes', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('signals only leaked probes and tolerates ones that already exited', async () => {
    const signal = vi.fn((pid: number) => {
      if (pid === 3) {
        throw new Error('ESRCH')
      }
    })
    const killed = await sweepLegacyPermissionStatusProbes({
      tmpRoot,
      uid,
      signal,
      readProcesses: async () => [
        row(leakedCommand, { pid: 1 }),
        row(`${helper} --permissions`, { pid: 2 }),
        row(leakedCommand, { pid: 3 }),
        row(leakedCommand, { pid: 4, uid: 0 })
      ]
    })

    expect(signal.mock.calls).toEqual([[1], [3]])
    expect(killed).toEqual([1])
  })

  it('does nothing off macOS', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const readProcesses = vi.fn(async () => [row(leakedCommand)])

    await expect(
      sweepLegacyPermissionStatusProbes({ tmpRoot, uid, readProcesses, signal: vi.fn() })
    ).resolves.toEqual([])
    expect(readProcesses).not.toHaveBeenCalled()
  })
})

describe('readLaunchdChildHelperProcesses', () => {
  it('pairs launchd-parented helper executables with their full command line', async () => {
    runProcessMock
      .mockResolvedValueOnce({
        code: 0,
        timedOut: false,
        outputTruncated: false,
        stdout: [
          `    1     0     0 /sbin/launchd`,
          `33514     1   501 ${helper}`,
          `33600 33599   501 ${helper}`,
          `33700     1   501 /usr/bin/grep`,
          ''
        ].join('\n')
      })
      .mockResolvedValueOnce({
        code: 0,
        timedOut: false,
        outputTruncated: false,
        stdout: `33514 ${leakedCommand}\n`
      })

    await expect(readLaunchdChildHelperProcesses()).resolves.toEqual([
      { pid: 33514, parentPid: 1, uid, executable: helper, command: leakedCommand }
    ])
    expect(runProcessMock.mock.calls[1]![0].args).toEqual([
      '-ww',
      '-p',
      '33514',
      '-o',
      'pid=,command='
    ])
  })

  it('fails instead of sweeping from a truncated process list', async () => {
    runProcessMock.mockResolvedValueOnce({
      code: 0,
      timedOut: false,
      outputTruncated: true,
      stdout: `33514     1   501 ${helper}\n`
    })

    await expect(readLaunchdChildHelperProcesses()).rejects.toThrow('Could not list processes')
  })
})
