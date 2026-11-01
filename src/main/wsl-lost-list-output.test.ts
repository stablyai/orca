import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const { runProcessMock, runProcessSyncMock, consoleMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  runProcessSyncMock: vi.fn<(spec: ProcessSpec) => ProcessResult>(),
  consoleMock: vi.fn<(registered: readonly string[], timeoutMs: number) => Promise<string[]>>()
}))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))
vi.mock('./wsl-console-running-distros', () => ({
  listRunningWslDistrosViaConsole: consoleMock
}))

import {
  _resetWslCachesForTests,
  listRunningWslDistrosAsync,
  listWslDistros,
  listWslDistrosAsync
} from './wsl'

// The reporter's capture of `wsl.exe --list --quiet` through process-host on WSL 3.0.3 (#35509).
const LOST_LIST_OUTPUT: ProcessResult = {
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  outputTruncated: false
}

const LXSS = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
const DEFAULT_ID = '0283592D-BE56-40D4-B935-3DC18C3AA007'
const REG_OUTPUT = [
  '',
  LXSS,
  `    DefaultDistribution    REG_SZ    {${DEFAULT_ID}}`,
  '    DefaultVersion    REG_DWORD    0x2',
  '',
  `${LXSS}\\{1b2c3d4e-0000-4000-8000-000000000001}`,
  '    DistributionName    REG_SZ    docker-desktop',
  '',
  `${LXSS}\\{3c4d5e6f-0000-4000-8000-000000000002}`,
  '    DistributionName    REG_SZ    Debian',
  '',
  `${LXSS}\\{${DEFAULT_ID}}`,
  '    DistributionName    REG_SZ    Ubuntu-24.04',
  '    Version    REG_DWORD    0x2',
  ''
].join('\r\n')

function exited(stdout: string): ProcessResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

function host(wslList: ProcessResult, reg: ProcessResult): (spec: ProcessSpec) => ProcessResult {
  return (spec) => (spec.program.toLowerCase().endsWith('reg.exe') ? reg : wslList)
}

function wslCalls(): string[][] {
  return runProcessMock.mock.calls
    .map(([spec]) => spec)
    .filter((spec) => spec.program === 'wsl.exe')
    .map((spec) => [...(spec.args ?? [])])
}

async function onWindows<T>(fn: () => Promise<T> | T): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('a host where wsl.exe loses its redirected list output', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    consoleMock.mockReset()
    _resetWslCachesForTests()
  })

  it('discovers the registered distros, default first, so WSL stays selectable', async () => {
    runProcessMock.mockImplementation(async (spec) =>
      host(LOST_LIST_OUTPUT, exited(REG_OUTPUT))(spec)
    )

    await onWindows(async () => {
      await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu-24.04', 'Debian'])
    })
  })

  it('fills the synchronous path from the registry without a synchronous spawn', async () => {
    runProcessSyncMock.mockReturnValue(LOST_LIST_OUTPUT)
    runProcessMock.mockImplementation(async (spec) =>
      host(LOST_LIST_OUTPUT, exited(REG_OUTPUT))(spec)
    )

    await onWindows(async () => {
      expect(listWslDistros()).toEqual([])
      await vi.waitFor(() => expect(listWslDistros()).toEqual(['Ubuntu-24.04', 'Debian']))
      expect(runProcessSyncMock.mock.calls.map(([spec]) => spec.program)).toEqual(['wsl.exe'])
    })
  })

  it('reads running distros through a console instead of reporting them stopped', async () => {
    runProcessMock.mockImplementation(async (spec) =>
      host(LOST_LIST_OUTPUT, exited(REG_OUTPUT))(spec)
    )
    consoleMock.mockResolvedValue(['Ubuntu-24.04'])

    await onWindows(async () => {
      await expect(listRunningWslDistrosAsync({ requireConfirmed: true })).resolves.toEqual([
        'Ubuntu-24.04'
      ])
      expect(consoleMock).toHaveBeenCalledWith(['Ubuntu-24.04', 'Debian'], 5000)
      // Only list calls: nothing here may start a stopped distro.
      expect(wslCalls()).toEqual([
        ['--list', '--running', '--quiet'],
        ['--list', '--quiet']
      ])
    })
  })

  it('goes straight to the console once the host is known to lose list output', async () => {
    runProcessMock.mockImplementation(async (spec) =>
      host(LOST_LIST_OUTPUT, exited(REG_OUTPUT))(spec)
    )
    consoleMock.mockResolvedValue(['Ubuntu-24.04'])

    await onWindows(async () => {
      await listRunningWslDistrosAsync({ requireConfirmed: true })
      await listRunningWslDistrosAsync({ requireConfirmed: true })
      expect(consoleMock).toHaveBeenCalledTimes(2)
      expect(wslCalls()).toEqual([
        ['--list', '--running', '--quiet'],
        ['--list', '--quiet']
      ])
    })
  })

  it('leaves the answer unverifiable, never stopped, when the console fails too', async () => {
    runProcessMock.mockImplementation(async (spec) =>
      host(LOST_LIST_OUTPUT, exited(REG_OUTPUT))(spec)
    )
    consoleMock.mockRejectedValue(new Error('wsl.exe console list timed out'))

    await onWindows(async () => {
      await expect(listRunningWslDistrosAsync({ requireConfirmed: true })).rejects.toThrow(
        'discovery is unavailable'
      )
    })
  })
})
