import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

// End to end through the real `wsl --list --running` parse; only process spawns are faked.
const mocks = vi.hoisted(() => ({ runProcess: vi.fn(), runWslProcess: vi.fn() }))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runProcess: mocks.runProcess
}))
vi.mock('../wsl/wsl-runner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runWslProcess: mocks.runWslProcess
}))

import { _resetWslCachesForTests } from '../wsl'
import { _resetWslBackgroundDistroGateForTests } from '../wsl-background-distro-gate'
import { runAsWslExecUserAct } from '../wsl/wsl-background-exec-gate'
import { _resetPreflightCache, runPreflightCheck } from './agent-detection'

function runningList(...distros: string[]): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: distros.map((distro) => `${distro}\n`).join(''),
    stderr: '',
    timedOut: false
  }
}

let originalPlatform: NodeJS.Platform

beforeEach(() => {
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.runProcess.mockReset().mockResolvedValue(runningList())
  mocks.runWslProcess.mockReset().mockResolvedValue({
    environmentResolved: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  _resetPreflightCache()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  _resetWslCachesForTests()
  _resetWslBackgroundDistroGateForTests()
})

describe('runPreflightCheck against the real running list (E9)', () => {
  it('refuses a forced check of a distro the running list omits, running nothing in it', async () => {
    await expect(runPreflightCheck(true, { wslDistro: 'Ubuntu' })).rejects.toThrow(
      "WSL distro 'Ubuntu' is not running"
    )
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it('runs inside a user act on that distro', async () => {
    await runAsWslExecUserAct('Ubuntu', () => runPreflightCheck(true, { wslDistro: 'Ubuntu' }))
    expect(mocks.runWslProcess).toHaveBeenCalled()
  })

  it('a user act on another distro does not admit this one', async () => {
    await expect(
      runAsWslExecUserAct('Debian', () => runPreflightCheck(true, { wslDistro: 'Ubuntu' }))
    ).rejects.toThrow("WSL distro 'Ubuntu' is not running")
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it('probes a listed running distro', async () => {
    mocks.runProcess.mockResolvedValue(runningList('Ubuntu'))
    await runPreflightCheck(true, { wslDistro: 'Ubuntu' })
    expect(mocks.runWslProcess).toHaveBeenCalled()
  })
})
