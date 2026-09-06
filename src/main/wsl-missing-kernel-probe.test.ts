import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { runProcess, runProcessSync } from '../shared/child-process/run-process'
import {
  _resetWslAvailabilityCacheForTests,
  isWslAvailable,
  isWslAvailableAsync
} from './wsl-availability'

vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }))
vi.mock('../shared/child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))
vi.mock('./wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))

const originalPlatform = process.platform
const success = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  _resetWslAvailabilityCacheForTests()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  _resetWslAvailabilityCacheForTests()
})

for (const mode of ['sync', 'async'] as const) {
  describe(`${mode} WSL1 availability without WSL2 kernel`, () => {
    const probe = () => (mode === 'sync' ? isWslAvailable() : isWslAvailableAsync())
    function failStatus(code: number): void {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw { status: code }
      })
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1) as (error: unknown) => void
        callback({ code })
        return {} as ReturnType<typeof execFile>
      })
    }
    function guestResult(result: typeof success): void {
      vi.mocked(runProcess).mockResolvedValue(result)
      vi.mocked(runProcessSync).mockReturnValue(result)
    }

    for (const status of [-444, 4_294_966_852]) {
      it(`requires guest execution and caches its success for ${status}`, async () => {
        failStatus(status)
        guestResult(success)
        expect(await probe()).toBe(true)
        expect(await probe()).toBe(true)
        const runner = mode === 'sync' ? runProcessSync : runProcess
        expect(runner).toHaveBeenCalledTimes(1)
        expect(runner).toHaveBeenCalledWith(
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
      { ...success, timedOut: true }
    ]) {
      it(`keeps failed guest unavailable: ${JSON.stringify(result)}`, async () => {
        failStatus(-444)
        guestResult(result)
        expect(await probe()).toBe(false)
      })
    }

    it('does not probe a guest for unrelated status failures', async () => {
      failStatus(1)
      expect(await probe()).toBe(false)
      expect(runProcess).not.toHaveBeenCalled()
      expect(runProcessSync).not.toHaveBeenCalled()
    })
  })
}
