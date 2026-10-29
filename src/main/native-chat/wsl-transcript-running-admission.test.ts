import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn(),
  runFsProcess: vi.fn(async () => [])
}))

vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('./wsl-transcript-fs-process-dispatch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runWslTranscriptFsProcess: mocks.runFsProcess
}))

import { _resetWslCachesForTests } from '../wsl'
import { _resetWslBackgroundDistroGateForTests } from '../wsl-background-distro-gate'
import { runAsWslUserAct } from '../wsl/wsl-unc-access-gate'
import { wslGatedReaddir } from './wsl-transcript-fs-access'
import { resetWslTranscriptFsGateForTests, WslTranscriptFsError } from './wsl-transcript-fs-gate'
import { WSL_TRANSCRIPT_RUNNING_LEASE_MS } from './wsl-transcript-running-admission'

const SESSIONS = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects'

function runningList(...distros: string[]): ProcessResult {
  const stdout = distros.map((distro) => `${distro}\n`).join('')
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

const listProbes = (): number =>
  mocks.runProcess.mock.calls.filter(([spec]) => spec.args?.includes('--running')).length

let originalPlatform: NodeJS.Platform

beforeEach(() => {
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.runProcess.mockReset()
  mocks.runFsProcess.mockClear()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  _resetWslCachesForTests()
  _resetWslBackgroundDistroGateForTests()
  resetWslTranscriptFsGateForTests()
  vi.useRealTimers()
})

describe('transcript reads never boot a stopped WSL distro (E9)', () => {
  it('refuses a background read of a stopped distro without touching its files', async () => {
    mocks.runProcess.mockResolvedValue(runningList())

    const read = wslGatedReaddir(SESSIONS, 'scan')

    await expect(read).rejects.toBeInstanceOf(WslTranscriptFsError)
    await expect(read).rejects.toThrow("WSL distro 'Ubuntu' is not running")
    expect(mocks.runFsProcess).not.toHaveBeenCalled()
  })

  it('reads a running distro', async () => {
    mocks.runProcess.mockResolvedValue(runningList('Ubuntu'))

    await expect(wslGatedReaddir(SESSIONS, 'scan')).resolves.toEqual([])
    expect(mocks.runFsProcess).toHaveBeenCalledOnce()
  })

  it('re-checks a running read older than its short lease, as after a `wsl --terminate`', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date', 'setTimeout'] })
    mocks.runProcess.mockResolvedValue(runningList('Ubuntu'))
    await wslGatedReaddir(SESSIONS, 'scan')

    // The distro is terminated; nothing tells this process. The next read must ask again.
    mocks.runProcess.mockResolvedValue(runningList())
    vi.advanceTimersByTime(WSL_TRANSCRIPT_RUNNING_LEASE_MS + 1)

    await expect(wslGatedReaddir(SESSIONS, 'scan')).rejects.toThrow('is not running')
    expect(listProbes()).toBe(2)
    expect(mocks.runFsProcess).toHaveBeenCalledOnce()
  })

  it("lets a user act on the distro read it, as the user's own touch may start it", async () => {
    mocks.runProcess.mockResolvedValue(runningList())

    await expect(
      runAsWslUserAct('Ubuntu', () => wslGatedReaddir(SESSIONS, 'exact'))
    ).resolves.toEqual([])
    expect(mocks.runFsProcess).toHaveBeenCalledOnce()
  })
})
