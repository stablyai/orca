import './rpc/unused-default-rpc-methods.test-fixture'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { GIT_METHODS } from './rpc/methods/git'
import { RuntimeGitStagingCommands } from './runtime-git-staging-commands'
import type * as RuntimeGitCommandTarget from './runtime-git-command-target'
import type { RuntimeGitCommandHost } from './runtime-git-command-target'

const providerOverride = vi.hoisted(() => {
  const state: { provider: unknown } = { provider: null }
  return state
})

vi.mock('./runtime-git-command-target', async (importActual) => {
  const actual = await importActual<typeof RuntimeGitCommandTarget>()
  return {
    ...actual,
    requireRuntimeGitProvider: (target: RuntimeGitCommandTarget.RuntimeGitTarget) =>
      providerOverride.provider ?? actual.requireRuntimeGitProvider(target)
  }
})

const tempRoots: string[] = []

function names(repo: string, args: string[]): string[] {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean)
}

async function createSharedLinkWorktree(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-runtime-stage-scope-'))
  const owner = await mkdtemp(path.join(tmpdir(), 'orca-runtime-stage-owner-'))
  tempRoots.push(repo, owner)
  const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  git(['config', 'commit.gpgsign', 'false'])
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'initial'])
  await mkdir(path.join(owner, 'node_modules'))
  await symlink(path.join(owner, 'node_modules'), path.join(repo, 'node_modules'))
  await writeFile(path.join(repo, 'new.txt'), 'new\n')
  return repo
}

// The members of a resolved git target that bulk staging reads.
type StagingTargetStub = {
  worktree: { path: string }
  repo?: { path: string; symlinkPaths: string[] }
  executionHostId: string
}

function dispatcherFor(target: StagingTargetStub): RpcDispatcher {
  const host = { resolveRuntimeGitTarget: async () => target }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bulkStageRuntimeGitPaths reads only resolveRuntimeGitTarget, and the targets below carry every member it reads.
  const commands = new RuntimeGitStagingCommands(host as unknown as RuntimeGitCommandHost)
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bulkStageRuntimeGitPaths: commands.bulkStageRuntimeGitPaths.bind(commands)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: git.bulkStage dispatch reads only the two members stubbed here.
  const runtimeService = runtime as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime: runtimeService, methods: GIT_METHODS })
}

afterEach(async () => {
  providerOverride.provider = null
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('git.bulkStage with a whole-worktree scope', () => {
  it('replies with a receipt and skips the shared node_modules link', async () => {
    const repo = await createSharedLinkWorktree()
    const dispatcher = dispatcherFor({
      worktree: { path: repo },
      repo: { path: repo, symlinkPaths: ['node_modules'] },
      executionHostId: 'local'
    })

    const response = await dispatcher.dispatch({
      id: 'stage-all',
      authToken: 'token',
      method: 'git.bulkStage',
      params: { worktree: 'id:wt-1', filePaths: [], scope: 'all' }
    })

    expect(response).toMatchObject({ ok: true, result: { ok: true, stagedScope: 'all' } })
    expect(names(repo, ['diff', '--cached', '--name-only'])).toEqual(['new.txt'])
  })

  it('replies with a receipt only after the SSH provider confirmed the scope', async () => {
    const bulkStageFiles = vi.fn().mockResolvedValue(undefined)
    providerOverride.provider = { bulkStageFiles }
    const dispatcher = dispatcherFor({
      worktree: { path: '/remote/repo' },
      executionHostId: 'ssh:conn-1'
    })

    const response = await dispatcher.dispatch({
      id: 'stage-all-ssh',
      authToken: 'token',
      method: 'git.bulkStage',
      params: { worktree: 'id:wt-1', filePaths: [], scope: 'tracked' }
    })

    expect(bulkStageFiles).toHaveBeenCalledWith('/remote/repo', [], 'tracked')
    expect(response).toMatchObject({ ok: true, result: { ok: true, stagedScope: 'tracked' } })
  })
})
