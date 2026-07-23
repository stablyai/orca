import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareEmulatorDesktopRuntime } from '../scripts/start-emulator-desktop-runtime.mjs'

describe('mobile emulator desktop runtime', () => {
  it('builds and selects the current worktree runtime by default', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const cli = await prepareEmulatorDesktopRuntime({
      worktree: '/repo',
      cliOverride: undefined,
      runCommand,
      logStep: vi.fn(),
      logSuccess: vi.fn()
    })

    expect(cli).toBe(join('/repo', 'config', 'scripts', 'orca-dev.mjs'))
    expect(runCommand).toHaveBeenNthCalledWith(1, 'pnpm', ['run', 'build:cli'], {
      cwd: '/repo',
      timeout: 300_000
    })
    expect(runCommand).toHaveBeenNthCalledWith(2, 'pnpm', ['run', 'build:electron-vite'], {
      cwd: '/repo',
      timeout: 300_000
    })
  })

  it('respects an explicit CLI without rebuilding', async () => {
    const runCommand = vi.fn()
    await expect(
      prepareEmulatorDesktopRuntime({
        worktree: '/repo',
        cliOverride: ' /custom/orca ',
        runCommand,
        logStep: vi.fn(),
        logSuccess: vi.fn()
      })
    ).resolves.toBe('/custom/orca')
    expect(runCommand).not.toHaveBeenCalled()
  })
})
