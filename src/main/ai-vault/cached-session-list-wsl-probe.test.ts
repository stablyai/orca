import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock, scanAiVaultSessionsInService } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  scanAiVaultSessionsInService: vi.fn()
}))

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runProcess: runProcessMock
}))
vi.mock('./session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService
}))
vi.mock('./opencode-wsl-runtime-preparation', () => ({
  prepareOpenCodeWslReaders: vi.fn(async () => [])
}))

import { _resetWslCachesForTests, _setWslCachesForTests, listWslDistrosAsync } from '../wsl'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import {
  configureAiVaultSessionSources,
  getAiVaultWslHomeDirs,
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from './cached-session-list'

const NATIVE_CODEX_HOME = 'C:\\Users\\ada\\.codex'
const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'

function exited(stdout: string, code: number | null = 0): ProcessResult {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

const FAILED = exited('', 1)

function wslSpawns(): string[][] {
  return runProcessMock.mock.calls
    .filter(([spec]) => spec.program === 'wsl.exe')
    .map(([spec]) => spec.args.map(String))
}

// Why the real wsl module: the point is the wsl.exe spawn count across the WHOLE
// listing Promise.all, which a per-function mock cannot observe.
describe('AI Vault listing wsl.exe probes', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    resetAiVaultSessionListCacheForTests()
    configureAiVaultSessionSources({ getAdditionalCodexHomePaths: () => [NATIVE_CODEX_HOME] })
    scanAiVaultSessionsInService.mockResolvedValue({ sessions: [], issues: [], scannedAt: 'scan' })
  })
  afterEach(() => {
    runProcessMock.mockReset()
    _resetWslCachesForTests()
    resetAiVaultSessionListCacheForTests()
    vi.restoreAllMocks()
  })

  it('spawns no wsl.exe for native-only codex homes when no distro is installed', async () => {
    _setWslCachesForTests({ distros: [] })

    await listAiVaultSessions()

    expect(wslSpawns()).toEqual([])
    expect(scanAiVaultSessionsInService).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalCodexSessionsDirs: [join(NATIVE_CODEX_HOME, 'sessions')],
        wslHomeDirs: []
      }),
      expect.anything(),
      expect.objectContaining({
        work: expect.any(Function),
        finish: expect.any(Function),
        fail: expect.any(Function)
      })
    )
  })

  it('still probes running distros when one is installed, so a later outage keeps the last-known-good list', async () => {
    _setWslCachesForTests({ distros: ['Ubuntu'] })
    runProcessMock.mockImplementation(
      ({ args }: { args: string[] }) =>
        new Promise<ProcessResult>((resolve) => {
          resolve(exited(args.includes('--running') ? 'Ubuntu\n' : '/home/ada\n'))
        })
    )

    await listAiVaultSessions()

    expect(wslSpawns()).toEqual([
      ['--list', '--running', '--quiet'],
      ['-d', 'Ubuntu', '--exec', 'bash', '-c', 'echo $HOME']
    ])
    expect(scanAiVaultSessionsInService).toHaveBeenCalledWith(
      expect.objectContaining({ wslHomeDirs: [WSL_HOME] }),
      expect.anything(),
      expect.objectContaining({
        work: expect.any(Function),
        finish: expect.any(Function),
        fail: expect.any(Function)
      })
    )

    runProcessMock.mockResolvedValue(FAILED)
    await expect(filterPathsToRunningWslDistrosAsync([`${WSL_HOME}\\.codex`])).resolves.toEqual([
      `${WSL_HOME}\\.codex`
    ])
  })

  // Why: a rejected `--list --quiet` yields [] without caching. Treating that as "no distro
  // installed" would narrow the allowed roots delete/subagent validation trusts.
  it('still discovers WSL homes after the installed-distro probe was rejected', async () => {
    runProcessMock.mockImplementation(
      ({ args }: { args: string[] }) =>
        new Promise<ProcessResult>((resolve) => {
          if (args.includes('--running')) {
            resolve(exited('Ubuntu\n'))
          } else if (args.includes('--list')) {
            resolve(FAILED)
          } else {
            resolve(exited('/home/ada\n'))
          }
        })
    )
    await expect(listWslDistrosAsync()).resolves.toEqual([])

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual([WSL_HOME])
    expect(wslSpawns()).toContainEqual(['--list', '--running', '--quiet'])
  })
})
