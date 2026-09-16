import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

const { execFileMock, scanAiVaultSessionsInWorker } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  scanAiVaultSessionsInWorker: vi.fn()
}))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: execFileMock
}))
vi.mock('./session-scanner-worker-spawn', () => ({
  scanAiVaultSessionsInWorker,
  resetAiVaultScannerWorkerForTests: vi.fn()
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

function wslSpawns(): string[][] {
  return execFileMock.mock.calls
    .filter(([command]) => command === 'wsl.exe')
    .flatMap(([, args]) => (Array.isArray(args) ? [args.map(String)] : []))
}

// Why the real wsl module: the point is the wsl.exe spawn count across the WHOLE
// listing Promise.all, which a per-function mock cannot observe.
describe('AI Vault listing wsl.exe probes', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    resetAiVaultSessionListCacheForTests()
    configureAiVaultSessionSources({ getAdditionalCodexHomePaths: () => [NATIVE_CODEX_HOME] })
    scanAiVaultSessionsInWorker.mockResolvedValue({ sessions: [], issues: [], scannedAt: 'scan' })
  })
  afterEach(() => {
    execFileMock.mockReset()
    _resetWslCachesForTests()
    resetAiVaultSessionListCacheForTests()
    vi.restoreAllMocks()
  })

  it('spawns no wsl.exe for native-only codex homes when no distro is installed', async () => {
    _setWslCachesForTests({ distros: [] })

    await listAiVaultSessions()

    expect(wslSpawns()).toEqual([])
    expect(scanAiVaultSessionsInWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalCodexSessionsDirs: [join(NATIVE_CODEX_HOME, 'sessions')],
        wslHomeDirs: []
      }),
      expect.anything()
    )
  })

  it('still probes running distros when one is installed, so a later outage keeps the last-known-good list', async () => {
    _setWslCachesForTests({ distros: ['Ubuntu'] })
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      callback(null, args.includes('--running') ? 'Ubuntu\n' : '/home/ada\n')
    })

    await listAiVaultSessions()

    expect(wslSpawns()).toEqual([
      ['--list', '--running', '--quiet'],
      ['-d', 'Ubuntu', '--exec', 'bash', '-c', 'echo $HOME']
    ])
    expect(scanAiVaultSessionsInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ wslHomeDirs: [WSL_HOME] }),
      expect.anything()
    )

    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('wsl unavailable'), '')
    })
    await expect(filterPathsToRunningWslDistrosAsync([`${WSL_HOME}\\.codex`])).resolves.toEqual([
      `${WSL_HOME}\\.codex`
    ])
  })

  // Why: a rejected `--list --quiet` yields [] without caching. Treating that as "no distro
  // installed" would narrow the allowed roots delete/subagent validation trusts.
  it('still discovers WSL homes after the installed-distro probe was rejected', async () => {
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      if (args.includes('--running')) {
        callback(null, 'Ubuntu\n')
      } else if (args.includes('--list')) {
        callback(new Error('wsl.exe transient failure'), '')
      } else {
        callback(null, '/home/ada\n')
      }
    })
    await expect(listWslDistrosAsync()).resolves.toEqual([])

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual([WSL_HOME])
    expect(wslSpawns()).toContainEqual(['--list', '--running', '--quiet'])
  })
})
