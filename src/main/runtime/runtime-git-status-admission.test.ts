import { describe, expect, it, vi } from 'vitest'
import type { GitAdmissionEvent } from '../git/command-runner/git-admission-state'
import { GitAdmissionScheduler } from '../git/command-runner/git-subprocess-admission'
import type * as GitStatusModule from '../git/status'
import type { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { GIT_METHODS } from './rpc/methods/git'
import { RuntimeGitStatusCommands } from './runtime-git-status-commands'

const getStatusMock = vi.hoisted(() => vi.fn())

vi.mock('../git/status', async () => ({
  ...(await vi.importActual<typeof GitStatusModule>('../git/status')),
  getStatus: getStatusMock
}))

describe('runtime git status admission', () => {
  it('admits RPC reads at the caller tier and defaults future tiers to status', async () => {
    const events: GitAdmissionEvent[] = []
    const scheduler = new GitAdmissionScheduler({
      onAdmissionEvent: (event) => events.push(event)
    })
    getStatusMock.mockImplementation(async (worktreePath, options) => {
      const grant = await scheduler.acquire({
        args: ['status'],
        cwd: worktreePath,
        tier: options.admissionTier
      })
      grant.release()
      return { entries: [], conflictOperation: 'none' }
    })
    const commands = new RuntimeGitStatusCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: { path: '/workspace/feature' },
        executionHostId: 'local'
      })
    } as never)
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitStatus: commands.getRuntimeGitStatus.bind(commands)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    for (const admissionTier of ['background', 'interactive', 'future-tier']) {
      const response = await dispatcher.dispatch({
        id: `request-${admissionTier}`,
        authToken: 'token',
        method: 'git.status',
        params: { worktree: 'id:wt-1', admissionTier }
      })
      expect(response.ok).toBe(true)
    }

    expect(events.filter((event) => event.phase === 'grant').map((event) => event.tier)).toEqual([
      'background',
      'interactive',
      'status'
    ])
  })
})
