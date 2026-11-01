import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DistroGateModule from '../wsl-background-distro-gate'
import type { Repo } from '../../shared/repo-types'
import type { RpcRequest } from './rpc/core'
import type { OrcaRuntimeService } from './orca-runtime'

const mocks = vi.hoisted(() => {
  const state: { distro: 'running' | 'stopped' } = { distro: 'stopped' }
  return {
    state,
    sourceRemote: vi.fn(async (): Promise<string> => {
      throw new Error('remote lookup reached')
    })
  }
})
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof DistroGateModule>()),
  readWslDistroRunningState: vi.fn(async () => mocks.state.distro)
}))
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectGitExecOptions: () => ({}),
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('./runtime-gitlab-issue-source-remote', () => ({
  resolveRuntimeGitLabIssueSourceRemote: mocks.sourceRemote
}))

import { resolveRuntimeGitLabWorktreeBase } from './runtime-gitlab-worktree-base'
import { RpcDispatcher } from './rpc/dispatcher'
import { WORKTREE_METHODS } from './rpc/methods/worktree'

const WSL_REPO: Repo = {
  id: 'repo-1',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}
const deps = { store: { getRepos: () => [WSL_REPO] }, resolveRepo: async () => WSL_REPO }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function resolve(wakeWslDistro?: boolean) {
  return resolveRuntimeGitLabWorktreeBase(
    { repoSelector: 'id:repo-1', mrIid: 7, sourceBranch: 'feature', wakeWslDistro },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the git options are mocked, so the store is only passed through.
    deps as unknown as Parameters<typeof resolveRuntimeGitLabWorktreeBase>[1]
  )
}

describe('GitLab MR start point for a stopped WSL distro (E9)', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.state.distro = 'stopped'
    mocks.sourceRemote.mockClear()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it("refuses Source Control's push-target ensure without touching the repo", async () => {
    await expect(resolve()).resolves.toEqual({
      error: "WSL distro 'Ubuntu' is not running. Open a terminal in it to start it."
    })
    expect(mocks.sourceRemote).not.toHaveBeenCalled()
  })

  it('resolves for the user creating from the MR', async () => {
    await expect(resolve(true)).resolves.toEqual({ error: 'remote lookup reached' })
    expect(mocks.sourceRemote).toHaveBeenCalled()
  })

  it('carries a paired client wake through worktree.resolveMrBase; other values drop', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveManagedMrBase: vi.fn().mockResolvedValue({ baseBranch: 'origin/main' })
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.resolveMrBase reads only resolveManagedMrBase.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: WORKTREE_METHODS
    })
    for (const wakeWslDistro of [undefined, true, 'yes']) {
      const request: RpcRequest = {
        id: 'req-1',
        authToken: 'tok',
        method: 'worktree.resolveMrBase',
        params: { repo: 'id:repo-1', mrIid: 7, wakeWslDistro }
      }
      await dispatcher.dispatch(request)
    }
    const wakes = runtime.resolveManagedMrBase.mock.calls.map(([args]) => args.wakeWslDistro)
    expect(wakes).toEqual([undefined, true, undefined])
  })
})
