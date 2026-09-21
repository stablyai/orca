import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitStatusModule from '../git/status'

const detectConflictOperationMock = vi.hoisted(() => vi.fn())

vi.mock('../git/status', async () => ({
  ...(await vi.importActual<typeof GitStatusModule>('../git/status')),
  detectConflictOperation: detectConflictOperationMock
}))

import { RuntimeGitStatusCommands } from './runtime-git-status-commands'

// Why: the conflict badge the runtime RPC serves is read from the worktree's `.git` pointer, so it
// must run in the same host namespace as the target's git — a WSL target's paths are guest-spelled.
describe('getRuntimeGitConflictOperation', () => {
  beforeEach(() => {
    detectConflictOperationMock.mockReset()
    detectConflictOperationMock.mockResolvedValue('merge')
  })

  it("probes with the target's local git options", async () => {
    const commands = new RuntimeGitStatusCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: { path: '/home/me/repo/feature' },
        executionHostId: 'local',
        localGitOptions: { wslDistro: 'Ubuntu' }
      })
    } as never)

    await expect(commands.getRuntimeGitConflictOperation('id:wt-1')).resolves.toBe('merge')

    expect(detectConflictOperationMock).toHaveBeenCalledWith('/home/me/repo/feature', {
      wslDistro: 'Ubuntu'
    })
  })
})
