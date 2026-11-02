import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'
import type { OpenCodeSqliteProcessOptions } from './session-scanner-opencode-sqlite-process-client'

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn<(spec: { args?: string[] }) => Promise<ProcessResult>>(),
  running: { distros: ['Ubuntu'] },
  create: vi.fn((_options: OpenCodeSqliteProcessOptions) => ({ dispose: vi.fn() })),
  readDb: vi.fn(() => new Map())
}))

vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('./session-scanner-opencode-sqlite-process-client', () => ({
  createOpenCodeSqliteProcessClient: mocks.create
}))
vi.mock('./session-scanner-opencode-sqlite-open', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readOpenCodeDatabase: mocks.readDb
}))
vi.mock('../wsl/wsl-executable-path', () => ({ resolveWslExecutablePath: () => 'wsl.exe' }))
vi.mock('../wsl-interop-spawn-directory', () => ({ resolveWslInteropSpawnCwd: () => 'C:\\' }))

import { _resetWslCachesForTests } from '../wsl'
import { _resetWslBackgroundDistroGateForTests } from '../wsl-background-distro-gate'
import { WSL_TRANSCRIPT_RUNNING_LEASE_MS } from '../native-chat/wsl-transcript-running-admission'
import {
  configureOpenCodeWslReaders,
  openCodeWslClient
} from './session-scanner-opencode-wsl-client'
import {
  devinSessionsIndexForSidecar,
  resetDevinSessionsIndexCacheForTests
} from './session-scanner-devin-db'
import { listRunningWslHomeDirsUnlessStopped } from '../wsl/wsl-home-unless-stopped'
import { clearWslHomeCache, rememberWslHome } from '../wsl-home-cache'
import { _resetRunningWslDistroCacheForTests } from '../wsl-running-distro-cache'
import { localAiVaultScanRoots } from './cached-session-list'

const DB = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.opencode\\opencode.db'
const DEVIN_DB = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.devin\\sessions.db'
let originalPlatform: NodeJS.Platform

beforeEach(() => {
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.running.distros = ['Ubuntu']
  mocks.runProcess.mockReset().mockImplementation(async (spec) => {
    if (!spec.args?.includes('--running')) {
      return { code: 1, signal: null, stdout: '', stderr: 'unexpected', timedOut: false }
    }
    const stdout = mocks.running.distros.map((distro) => `${distro}\n`).join('')
    return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
  })
  mocks.create.mockClear()
  mocks.readDb.mockClear()
  resetDevinSessionsIndexCacheForTests()
})

afterEach(() => {
  configureOpenCodeWslReaders([])
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  _resetWslCachesForTests()
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  clearWslHomeCache()
  vi.useRealTimers()
})

const listProbes = (): number =>
  mocks.runProcess.mock.calls.filter(([spec]) => spec.args?.includes('--running')).length

describe('session scanner after a `wsl --terminate`', () => {
  // verify-18 (a): the reader died with its distro, and its respawn inside the lease booted it.
  it('re-reads the running list before respawning an OpenCode reader that exited', async () => {
    configureOpenCodeWslReaders([
      { distro: 'Ubuntu', executable: '/usr/bin/node', readerPath: '/r.cjs' }
    ])
    await openCodeWslClient('Ubuntu', DB)
    const options = mocks.create.mock.calls[0]?.[0]
    await options?.beforeSpawn?.(new AbortController().signal)
    expect(listProbes()).toBe(1)

    mocks.running.distros = []
    options?.onUnexpectedExit?.()

    await expect(options?.beforeSpawn?.(new AbortController().signal)).rejects.toThrow(
      'is not running'
    )
    expect(listProbes()).toBe(2)
  })

  it('opens a WSL Devin sessions.db only on a running list from the transcript lease', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date', 'setTimeout'] })
    const sidecar = { path: DEVIN_DB, mtimeMs: 1, sizeBytes: 2 }
    await listRunningWslHomeDirsUnlessStopped()
    expect(devinSessionsIndexForSidecar(sidecar)).toMatchObject({ unreadable: false })
    expect(mocks.readDb).toHaveBeenCalledOnce()

    resetDevinSessionsIndexCacheForTests()
    vi.advanceTimersByTime(WSL_TRANSCRIPT_RUNNING_LEASE_MS + 1)
    expect(devinSessionsIndexForSidecar(sidecar)).toEqual({ index: null, unreadable: true })
    expect(mocks.readDb).toHaveBeenCalledOnce()
  })

  it('lists no WSL root from a stale list when the running list cannot be confirmed', async () => {
    const home = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
    rememberWslHome('Ubuntu', home)
    await expect(listRunningWslHomeDirsUnlessStopped()).resolves.toEqual([home])

    // The probe now fails; the last-known-good list still names Ubuntu, whose home is cached.
    mocks.runProcess.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'wsl failed',
      timedOut: false
    })
    await expect(listRunningWslHomeDirsUnlessStopped()).resolves.toEqual([])
    const roots = await localAiVaultScanRoots()
    expect(roots.wslHomeDirs).toEqual([])
  })
})
