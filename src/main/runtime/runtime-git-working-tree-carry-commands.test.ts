import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type * as SshGitDispatchModule from '../providers/ssh-git-dispatch'
import { SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-git-dispatch'
import type { OrcaRuntimeService } from './orca-runtime'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from './orca-runtime-git'
import type { RuntimeGitTarget } from './runtime-git-command-target'
import { RpcDispatcher } from './rpc/dispatcher'
import { GIT_METHODS } from './rpc/methods/git'

const mocks = vi.hoisted(() => ({
  getSshGitProvider: vi.fn(),
  carryLocalWorkingTreeChanges: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', async () => ({
  ...(await vi.importActual<typeof SshGitDispatchModule>('../providers/ssh-git-dispatch')),
  getSshGitProvider: mocks.getSshGitProvider
}))

vi.mock('../git/source-control/carry-working-tree-changes', () => ({
  carryLocalWorkingTreeChanges: mocks.carryLocalWorkingTreeChanges
}))

function worktree(id: string, path: string, repoId = 'repo-1'): ResolvedRuntimeGitWorktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the carry command reads only id, repoId and path.
  return {
    id,
    repoId,
    path,
    git: { path, branch: 'main', isBare: false, isMainWorktree: false }
  } as unknown as ResolvedRuntimeGitWorktree
}

function commandsFor(targets: Record<string, RuntimeGitTarget>): RuntimeGitCommands {
  return new RuntimeGitCommands({
    resolveRuntimeGitTarget: async (selector) => {
      const target = targets[selector]
      if (!target) {
        throw new Error(`unknown selector ${selector}`)
      }
      return target
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carry never reads settings.
    getRuntimeSettings: () => ({}) as GlobalSettings
  })
}

const CARRIED = { ok: true, trackedChanges: true, untrackedCopied: 2 } as const

describe('runtime working-tree carry', () => {
  beforeEach(() => {
    mocks.getSshGitProvider.mockReset().mockReturnValue(undefined)
    mocks.carryLocalWorkingTreeChanges.mockReset().mockResolvedValue(CARRIED)
  })

  it('carries between local worktrees with the target host git options', async () => {
    const commands = commandsFor({
      'id:a': { worktree: worktree('a', '/r/a'), executionHostId: 'local' },
      'id:b': {
        worktree: worktree('b', '/r/b'),
        executionHostId: 'local',
        localGitOptions: { wslDistro: 'Ubuntu' }
      }
    })

    await expect(commands.carryRuntimeWorkingTreeChanges('id:a', 'id:b')).resolves.toEqual(CARRIED)
    expect(mocks.carryLocalWorkingTreeChanges).toHaveBeenCalledWith('/r/a', '/r/b', {
      wslDistro: 'Ubuntu',
      admissionTier: 'interactive'
    })
  })

  it('runs the carry on the ssh host that owns both worktrees', async () => {
    const provider = { carryWorkingTreeChanges: vi.fn().mockResolvedValue(CARRIED) }
    mocks.getSshGitProvider.mockReturnValue(provider)
    const commands = commandsFor({
      'id:a': { worktree: worktree('a', '/remote/a'), executionHostId: 'ssh:ssh-1' },
      'id:b': { worktree: worktree('b', '/remote/b'), executionHostId: 'ssh:ssh-1' }
    })

    await expect(commands.carryRuntimeWorkingTreeChanges('id:a', 'id:b')).resolves.toEqual(CARRIED)
    expect(provider.carryWorkingTreeChanges).toHaveBeenCalledWith('/remote/a', '/remote/b')
    expect(mocks.carryLocalWorkingTreeChanges).not.toHaveBeenCalled()
  })

  it('never falls back to local git when the ssh host is unreachable', async () => {
    const commands = commandsFor({
      'id:a': { worktree: worktree('a', '/remote/a'), executionHostId: 'ssh:ssh-1' },
      'id:b': { worktree: worktree('b', '/remote/b'), executionHostId: 'ssh:ssh-1' }
    })

    await expect(commands.carryRuntimeWorkingTreeChanges('id:a', 'id:b')).rejects.toThrow(
      SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
    )
    expect(mocks.carryLocalWorkingTreeChanges).not.toHaveBeenCalled()
  })

  it('refuses worktrees that live on different hosts', async () => {
    const commands = commandsFor({
      'id:a': { worktree: worktree('a', '/r/a'), executionHostId: 'local' },
      'id:b': { worktree: worktree('b', '/remote/b'), executionHostId: 'ssh:ssh-1' }
    })

    await expect(commands.carryRuntimeWorkingTreeChanges('id:a', 'id:b')).rejects.toThrow(
      'Source and target worktrees must share a host'
    )
    expect(mocks.carryLocalWorkingTreeChanges).not.toHaveBeenCalled()
  })

  it('refuses worktrees from different repositories', async () => {
    const commands = commandsFor({
      'id:a': { worktree: worktree('a', '/r/a', 'repo-1'), executionHostId: 'local' },
      'id:b': { worktree: worktree('b', '/s/b', 'repo-2'), executionHostId: 'local' }
    })

    await expect(commands.carryRuntimeWorkingTreeChanges('id:a', 'id:b')).rejects.toThrow(
      'Source and target worktrees must belong to the same repository'
    )
    expect(mocks.carryLocalWorkingTreeChanges).not.toHaveBeenCalled()
  })
})

describe('git.carryWorkingTreeChanges RPC', () => {
  function dispatcherWith(carry: ReturnType<typeof vi.fn>): RpcDispatcher {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only these two members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      carryRuntimeWorkingTreeChanges: carry
    } as unknown as OrcaRuntimeService
    return new RpcDispatcher({ runtime, methods: GIT_METHODS })
  }

  it('passes both worktree selectors to the runtime', async () => {
    const carry = vi.fn().mockResolvedValue(CARRIED)

    const response = await dispatcherWith(carry).dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'git.carryWorkingTreeChanges',
      params: { sourceWorktree: 'id:a', targetWorktree: 'id:b' }
    })

    expect(carry).toHaveBeenCalledWith('id:a', 'id:b')
    expect(response).toMatchObject({ ok: true, result: CARRIED })
  })

  it('rejects a missing target selector before calling the runtime', async () => {
    const carry = vi.fn()

    const response = await dispatcherWith(carry).dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'git.carryWorkingTreeChanges',
      params: { sourceWorktree: 'id:a' }
    })

    expect(response).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'invalid_argument' })
    })
    expect(carry).not.toHaveBeenCalled()
  })
})
