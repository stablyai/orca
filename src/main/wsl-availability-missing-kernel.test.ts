import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { _resetWslAvailabilityCacheForTests, isWslAvailableAsync } from './wsl-availability'

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn()
}))
vi.mock('./wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))

const originalPlatform = process.platform
const success: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

describe('WSL1 availability without WSL2 kernel', () => {
  const guestCalls = () =>
    vi.mocked(runProcess).mock.calls.filter(([spec]) => spec.args?.[0] === '--exec')
  let statusCode = 0
  let guest: () => ProcessResult = () => success

  function failStatus(code: number): void {
    statusCode = code
  }
  function guestResult(result: ProcessResult): void {
    guest = () => result
  }
  function respond(spec: ProcessSpec): ProcessResult {
    return spec.args?.[0] === '--status' ? { ...success, code: statusCode } : guest()
  }

  beforeEach(() => {
    vi.resetAllMocks()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    _resetWslAvailabilityCacheForTests()
    statusCode = 0
    guest = () => success
    vi.mocked(runProcess).mockImplementation(async (spec) => respond(spec))
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    _resetWslAvailabilityCacheForTests()
  })

  // Node reports the Windows DWORD; the console prints its signed equivalent.
  for (const status of [-444, 4_294_966_852]) {
    it(`requires guest execution and caches its success for ${status}`, async () => {
      failStatus(status)
      guestResult(success)
      expect(await isWslAvailableAsync()).toBe(true)
      expect(await isWslAvailableAsync()).toBe(true)
      expect(guestCalls()).toHaveLength(1)
      expect(runProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          program: 'wsl.exe',
          args: ['--exec', '/bin/true'],
          timeoutMs: 5000,
          cwd: 'C:\\Windows'
        })
      )
    })
  }

  for (const result of [
    { ...success, code: 1 },
    { ...success, code: null, timedOut: true }
  ]) {
    it(`keeps a failed guest unavailable: ${JSON.stringify(result)}`, async () => {
      failStatus(-444)
      guestResult(result)
      expect(await isWslAvailableAsync()).toBe(false)
    })
  }

  it('stays unavailable when the guest probe cannot be spawned', async () => {
    failStatus(-444)
    guest = () => {
      throw new Error('EPERM')
    }
    expect(await isWslAvailableAsync()).toBe(false)
  })

  it('does not probe a guest for unrelated status failures', async () => {
    failStatus(1)
    expect(await isWslAvailableAsync()).toBe(false)
    expect(guestCalls()).toHaveLength(0)
  })
})
