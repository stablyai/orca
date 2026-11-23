import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeGitSyncCommands } from './runtime-git-sync-commands'
import type * as RuntimeGitCommandTarget from './runtime-git-command-target'
import type { RuntimeGitCommandHost } from './runtime-git-command-target'

const stubs = vi.hoisted(() => ({
  assertRunning: vi.fn(async (): Promise<void> => {}),
  continueRebase: vi.fn(async () => ({ outcome: 'none' }))
}))

vi.mock('./runtime-wsl-background-read-gate', () => ({
  assertRuntimeReadWslDistroRunning: stubs.assertRunning
}))

vi.mock('./runtime-git-command-target', async (importActual) => {
  const actual = await importActual<typeof RuntimeGitCommandTarget>()
  return {
    ...actual,
    requireRuntimeGitProvider: () => ({ continueRebase: stubs.continueRebase })
  }
})

const TARGET = {
  worktree: { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' },
  executionHostId: 'local',
  localGitOptions: { wslDistro: 'Ubuntu' }
}

function commands(): RuntimeGitSyncCommands {
  const host = { resolveRuntimeGitTarget: async () => TARGET }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: continueRuntimeGitRebase reads only resolveRuntimeGitTarget, and TARGET carries every member it reads.
  return new RuntimeGitSyncCommands(host as unknown as RuntimeGitCommandHost)
}

afterEach(() => {
  stubs.assertRunning.mockReset()
  stubs.assertRunning.mockImplementation(async () => {})
  stubs.continueRebase.mockClear()
})

describe('continueRuntimeGitRebase WSL gate', () => {
  it('refuses the automatic inspect on a stopped distro without running Git', async () => {
    stubs.assertRunning.mockRejectedValueOnce(new Error('WSL distro Ubuntu is stopped'))
    await expect(commands().continueRuntimeGitRebase('wt', 'inspect')).rejects.toThrow(
      'WSL distro Ubuntu is stopped'
    )
    expect(stubs.assertRunning).toHaveBeenCalledWith(TARGET, 'Ubuntu')
    expect(stubs.continueRebase).not.toHaveBeenCalled()
  })

  it('lets a user Continue through without the background-read gate', async () => {
    await commands().continueRuntimeGitRebase('wt', 'continue', {})
    expect(stubs.assertRunning).not.toHaveBeenCalled()
    expect(stubs.continueRebase).toHaveBeenCalledWith(TARGET.worktree.path, 'continue', {})
  })
})
