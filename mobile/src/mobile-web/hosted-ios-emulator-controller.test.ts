import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startHostedIosEmulatorController } from '../../scripts/hosted-ios-emulator-controller.mjs'

const args = {
  orcaCli: '/repo/config/scripts/orca-dev.mjs',
  runtimeDirectory: '/tmp/mobile-e2e',
  worktree: '/repo'
}

describe('hosted iOS emulator controller', () => {
  it('registers the worktree in an isolated stable runtime', async () => {
    const runtime = { env: { ORCA_USER_DATA_PATH: '/controller' }, stop: vi.fn() }
    const startRuntime = vi.fn(async () => runtime)
    const runCli = vi.fn(async () => ({ stdout: '{}', stderr: '' }))

    await expect(startHostedIosEmulatorController(args, startRuntime, runCli)).resolves.toBe(
      runtime
    )
    expect(startRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        orcaCli: args.orcaCli,
        cwd: args.worktree,
        runDirectory: path.join(args.runtimeDirectory, 'emulator-control')
      })
    )
    expect(runCli).toHaveBeenCalledWith(
      args.orcaCli,
      ['repo', 'add', '--path', args.worktree, '--json'],
      expect.objectContaining({ cwd: args.worktree, env: runtime.env })
    )
  })

  it('stops the controller when worktree registration fails', async () => {
    const runtime = { env: {}, stop: vi.fn(async () => {}) }
    const error = new Error('registration failed')

    await expect(
      startHostedIosEmulatorController(
        args,
        async () => runtime,
        async () => {
          throw error
        }
      )
    ).rejects.toBe(error)
    expect(runtime.stop).toHaveBeenCalledOnce()
  })
})
