import { describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn((..._args: unknown[]) => ({ pid: 1 }))
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { spawnWslRelayProcess } from './wsl-hook-relay-launch'

describe('spawnWslRelayProcess', () => {
  it('names an explicit Windows directory rather than inheriting one', () => {
    spawnWslRelayProcess('Ubuntu', {}, '1.2.3')

    // A stable Windows cwd prevents deleted WSL worktrees from breaking future CreateProcessW calls.
    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      expect.arrayContaining(['-d', 'Ubuntu', '--exec']),
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })
})
