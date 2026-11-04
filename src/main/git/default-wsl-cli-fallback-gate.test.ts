// E9: a cwd-less gh/glab call whose host CLI is missing must not boot a stopped default distro from
// background work (rate limits, auth status, Settings, task-source probes).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSpawnReturning } from '../../shared/__fixtures__/fake-spawned-child'
import type * as WslModule from '../wsl'
import type * as BackgroundDistroGate from '../wsl-background-distro-gate'

const { spawnMock, getDefaultWslDistroMock, readWslDistroRunningStateMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn(),
  readWslDistroRunningStateMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: spawnMock
}))

vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: getDefaultWslDistroMock
}))

vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: readWslDistroRunningStateMock
}))

import { ghExecFileAsync, glabExecFileAsync, setDefaultWslDistroOverride } from './runner'
import { _resetGhRateLimitBreaker } from './gh-rate-limit-breaker'
import { runAsWslExecUserAct } from '../wsl/wsl-background-exec-gate'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../wsl/wsl-unc-access-gate'

const originalPlatform = process.platform

const CLIS = [
  { cli: 'gh', run: () => ghExecFileAsync(['api', 'rate_limit']) },
  { cli: 'glab', run: () => glabExecFileAsync(['api', 'user']) }
] as const

function hostMissingThenWslAnswers(cli: string): void {
  spawnMock
    .mockImplementationOnce(
      fakeSpawnReturning({
        spawnError: Object.assign(new Error(`spawn ${cli} ENOENT`), { code: 'ENOENT' })
      })
    )
    .mockImplementationOnce(fakeSpawnReturning({ stdout: '{}' }))
}

function spawnedWsl(): boolean {
  return spawnMock.mock.calls.some(([program]) => program === 'wsl.exe')
}

beforeEach(() => {
  spawnMock.mockReset()
  getDefaultWslDistroMock.mockReset().mockReturnValue('Ubuntu')
  readWslDistroRunningStateMock.mockReset().mockResolvedValue('running')
  setDefaultWslDistroOverride(null)
  _resetGhRateLimitBreaker()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  _resetGhRateLimitBreaker()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe.each(CLIS)('$cli default-distro fallback', ({ cli, run }) => {
  it('never starts a stopped default distro, and says it is stopped rather than missing', async () => {
    readWslDistroRunningStateMock.mockResolvedValue('stopped')
    hostMissingThenWslAnswers(cli)

    const error = await run().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WslDistroStoppedError)
    expect(String(error)).toContain("WSL distro 'Ubuntu' is not running")
    expect(String(error)).not.toMatch(/ENOENT|not found/)
    expect(spawnedWsl()).toBe(false)
  })

  it('never starts one whose state WSL could not report', async () => {
    readWslDistroRunningStateMock.mockResolvedValue('unverifiable')
    hostMissingThenWslAnswers(cli)

    await expect(run()).rejects.toBeInstanceOf(WslDistroUnverifiableError)
    expect(spawnedWsl()).toBe(false)
  })

  it('falls back to a running default distro as before', async () => {
    hostMissingThenWslAnswers(cli)

    await expect(run()).resolves.toEqual({ stdout: '{}', stderr: '' })
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'wsl.exe',
      expect.arrayContaining(['-d', 'Ubuntu']),
      expect.anything()
    )
  })

  it('still falls back to a stopped one inside a user act for it', async () => {
    readWslDistroRunningStateMock.mockResolvedValue('stopped')
    hostMissingThenWslAnswers(cli)

    await expect(runAsWslExecUserAct('Ubuntu', run)).resolves.toEqual({ stdout: '{}', stderr: '' })
    expect(spawnedWsl()).toBe(true)
  })
})
