import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import { gitExecFileAsync } from '../git/runner'
import { addSparseWorktree, addWorktree } from '../git/worktree'
import { openWorktreeCreatePathClaim } from '../worktree-create-in-flight'
import { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import { buildManagedWorktreeCreateArgs } from './rpc/methods/worktree-create-args'
import { RuntimeRemoteFetchController } from './runtime-remote-fetch-controller'
import { resolveRuntimeLocalWorktreeCreateCandidate } from './runtime-local-worktree-create-candidate'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...argv: string[]): Promise<string> {
  return (await gitExecFileAsync(argv, { cwd })).stdout.trim()
}

async function fixture(remote = 'origin') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-branch-reuse-')))
  roots.push(root)
  await git(root, 'init', '--quiet', 'repo')
  const repoPath = join(root, 'repo')
  await git(repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(repoPath, 'config', 'user.name', 'Branch Reuse Test')
  await git(repoPath, 'config', 'user.email', 'test@example.com')
  await git(repoPath, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  await git(repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'base')
  const branch = 'feature/nested'
  const base = `refs/remotes/${remote}/${branch}`
  await git(repoPath, 'remote', 'add', remote, repoPath)
  await git(repoPath, 'update-ref', base, 'HEAD')
  const initialTip = await git(repoPath, 'rev-parse', 'HEAD')
  const remoteTrackingBase = await new RuntimeRemoteFetchController().resolveRemoteTrackingBase(
    repoPath,
    base
  )
  const repo: Repo = { id: 'repo', path: repoPath, displayName: 'Repo', badgeColor: '', addedAt: 0 }
  const workspaceRoot = join(root, 'workspaces')
  const settings = { workspaceDir: workspaceRoot, nestWorkspaces: false, branchPrefix: '' }
  const candidate = async (request: Partial<CreateWorktreeArgs> = {}) => {
    const pathClaim = openWorktreeCreatePathClaim()
    try {
      return await resolveRuntimeLocalWorktreeCreateCandidate({
        request: {
          repoSelector: repo.id,
          name: 'My workspace',
          baseBranch: base,
          branchNameOverride: branch,
          branchIntent: 'open-existing-v2',
          ...request
        },
        repo,
        settings,
        worktreePathSettings: settings,
        workspaceRoot,
        username: '',
        baseBranch: base,
        remoteTrackingBase,
        localWorktreeGitOptions: {},
        pathClaim
      })
    } finally {
      pathClaim.release()
    }
  }
  const create = async (request: Partial<CreateWorktreeArgs> = {}) => {
    const picked = await candidate(request)
    const addResult = await addWorktree(
      repoPath,
      picked.worktreePath,
      picked.branchName,
      base,
      true,
      false,
      {
        checkoutExistingBranch: picked.checkoutExistingBranch,
        trackRemoteBranch:
          (request.branchIntent ?? 'open-existing-v2') === 'open-existing-v2' &&
          !picked.checkoutExistingBranch,
        ...(remoteTrackingBase ? { remoteTrackingBase } : {})
      }
    )
    return { ...picked, addResult }
  }
  return {
    root,
    repoPath,
    branch,
    base,
    initialTip,
    workspaceRoot,
    candidate,
    create,
    remoteTrackingBase
  }
}

describe('explicit branch reuse with real Git', () => {
  it('preserves an old V1 remote pick when the same-name local branch has diverged', async () => {
    const f = await fixture()
    await git(f.repoPath, 'checkout', '--quiet', '-b', f.branch)
    await git(f.repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'local work')
    const localTip = await git(f.repoPath, 'rev-parse', 'HEAD')
    await git(f.repoPath, 'checkout', '--quiet', 'main')
    await git(f.repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'remote work')
    await git(f.repoPath, 'update-ref', f.base, 'HEAD')
    const remoteTip = await git(f.repoPath, 'rev-parse', f.base)
    const request = buildManagedWorktreeCreateArgs(
      WorktreeCreate.parse({
        repo: 'repo',
        name: 'Legacy workspace',
        branchNameOverride: f.branch,
        baseBranch: f.base,
        branchIntent: 'open-existing'
      }),
      {}
    )
    const picked = await f.create({
      name: request.name,
      branchNameOverride: request.branchNameOverride,
      branchIntent: request.branchIntent
    })
    expect(picked.branchName).toBe(`${f.branch}-2`)
    expect(picked.checkoutExistingBranch).toBe(false)
    expect(await git(picked.worktreePath, 'rev-parse', 'HEAD')).toBe(remoteTip)
    expect(await git(f.repoPath, 'rev-parse', `refs/heads/${f.branch}`)).toBe(localTip)
    expect(await git(f.repoPath, 'rev-parse', f.base)).toBe(remoteTip)
  })

  it('keeps a V1 remote-only branch pinned across a workspace path collision', async () => {
    const f = await fixture()
    await mkdir(join(f.workspaceRoot, 'My-workspace'), { recursive: true })
    const picked = await f.create({ branchIntent: 'open-existing' })
    expect(picked.branchName).toBe(f.branch)
    expect(picked.worktreePath).toBe(join(f.workspaceRoot, 'My-workspace-2'))
    expect(await git(picked.worktreePath, 'rev-parse', 'HEAD')).toBe(f.initialTip)
  })

  for (const alias of ['feature/NESTED', 'FEATURE/nested']) {
    it(`rejects a loose ref alias of a busy branch (${alias})`, async (context) => {
      const f = await fixture()
      const busy = join(f.root, 'external-workspace')
      await git(f.repoPath, 'worktree', 'add', '--no-track', '-b', f.branch, busy, f.base)
      try {
        await git(f.repoPath, 'rev-parse', '--verify', `refs/heads/${alias}`)
      } catch {
        context.skip()
        return
      }
      await expect(f.create({ branchNameOverride: alias })).rejects.toThrow(
        'Select its exact branch name'
      )
      expect(
        (await git(f.repoPath, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)
      ).toHaveLength(2)
      expect(await git(f.repoPath, 'rev-parse', `refs/heads/${f.branch}`)).toBe(f.initialTip)
    })
  }

  it('rejects the exact branch when an older checkout recorded a case alias', async (context) => {
    const f = await fixture()
    const alias = 'feature/NESTED'
    const busy = join(f.root, 'alias-workspace')
    await git(f.repoPath, 'branch', f.branch)
    try {
      await git(f.repoPath, 'rev-parse', '--verify', `refs/heads/${alias}`)
    } catch {
      context.skip()
      return
    }
    await git(f.repoPath, 'worktree', 'add', busy, alias)
    expect(await git(busy, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${alias}`)
    await expect(f.create()).rejects.toThrow(`already checked out at "${busy}"`)
    expect(
      (await git(f.repoPath, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)
    ).toHaveLength(2)
  })

  it('allows distinct case-sensitive branches even when their commits are identical', async (context) => {
    const f = await fixture()
    await git(
      f.repoPath,
      'worktree',
      'add',
      '--no-track',
      '-b',
      f.branch,
      join(f.root, 'busy'),
      f.base
    )
    const other = 'feature/NESTED'
    const resolvesAlias = await git(
      f.repoPath,
      'rev-parse',
      '--verify',
      `refs/heads/${other}`
    ).then(
      () => true,
      () => false
    )
    if (resolvesAlias) {
      context.skip()
      return
    }
    await git(f.repoPath, 'branch', other, f.base)
    const picked = await f.create({ branchNameOverride: other })
    expect(picked.checkoutExistingBranch).toBe(true)
    expect(await git(picked.worktreePath, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${other}`)
  })

  it.each([false, true])(
    'creates from a ref outside a restricted fetch refspec (sparse=%s)',
    async (sparse) => {
      const f = await fixture('team/upstream')
      await git(
        f.repoPath,
        'config',
        'remote.team/upstream.fetch',
        '+refs/heads/main:refs/remotes/team/upstream/main'
      )
      const picked = await f.candidate()
      const create = sparse
        ? addSparseWorktree(
            f.repoPath,
            picked.worktreePath,
            picked.branchName,
            ['src'],
            f.base,
            false,
            { trackRemoteBranch: true, remoteTrackingBase: f.remoteTrackingBase ?? undefined }
          )
        : addWorktree(f.repoPath, picked.worktreePath, picked.branchName, f.base, false, false, {
            trackRemoteBranch: true,
            remoteTrackingBase: f.remoteTrackingBase ?? undefined
          })
      const result = await create
      expect(result.upstreamWarning).toContain('Check the push destination')
      expect(result.upstreamWarning).toContain(f.base)
      expect(await git(picked.worktreePath, 'rev-parse', 'HEAD')).toBe(f.initialTip)
      expect(await git(picked.worktreePath, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${f.branch}`)
      await expect(git(picked.worktreePath, 'rev-parse', '@{upstream}')).rejects.toThrow()
      expect(await git(f.repoPath, 'config', 'remote.team/upstream.fetch')).toBe(
        '+refs/heads/main:refs/remotes/team/upstream/main'
      )
    }
  )
  it.each(['origin', 'team/upstream'])(
    'materializes a remote-only branch and tracks the selected remote (%s)',
    async (remote) => {
      const f = await fixture(remote)
      const picked = await f.create()
      expect(picked.branchName).toBe(f.branch)
      expect(picked.checkoutExistingBranch).toBe(false)
      expect(picked.addResult.upstreamWarning).toBeUndefined()
      expect(await git(picked.worktreePath, 'rev-parse', 'HEAD')).toBe(f.initialTip)
      expect(
        await git(picked.worktreePath, 'rev-parse', '--symbolic-full-name', '@{upstream}')
      ).toBe(f.base)
    }
  )

  it.each(['ahead', 'diverged', 'behind'])(
    'reuses a %s local branch without changing its tip or upstream',
    async (state) => {
      const f = await fixture()
      await git(f.repoPath, 'branch', f.branch)
      await git(f.repoPath, 'config', `branch.${f.branch}.remote`, 'origin')
      await git(f.repoPath, 'config', `branch.${f.branch}.merge`, 'refs/heads/main')
      await git(f.repoPath, 'checkout', '--quiet', f.branch)
      if (state !== 'behind') {
        await git(f.repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'local work')
      }
      const localTip = await git(f.repoPath, 'rev-parse', 'HEAD')
      await git(f.repoPath, 'checkout', '--quiet', 'main')
      if (state !== 'ahead') {
        await git(f.repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'remote work')
        await git(f.repoPath, 'update-ref', f.base, 'HEAD')
      }
      const remoteTip = await git(f.repoPath, 'rev-parse', f.base)
      await mkdir(join(f.workspaceRoot, 'My-workspace'), { recursive: true })
      const picked = await f.create()
      expect(picked.checkoutExistingBranch).toBe(true)
      expect(picked.branchName).toBe(f.branch)
      expect(await git(picked.worktreePath, 'rev-parse', 'HEAD')).toBe(localTip)
      expect(await git(f.repoPath, 'rev-parse', f.base)).toBe(remoteTip)
      expect(await git(f.repoPath, 'config', `branch.${f.branch}.merge`)).toBe('refs/heads/main')
    }
  )

  it('reports the checkout path of a busy branch and allocates no replacement branch', async () => {
    const f = await fixture()
    const busy = join(f.root, 'external-workspace')
    await git(f.repoPath, 'worktree', 'add', '--no-track', '-b', f.branch, busy, f.base)
    await expect(f.create()).rejects.toThrow(`already checked out at "${busy}"`)
    expect(await git(f.repoPath, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      `refs/heads/${f.branch}\nrefs/heads/main`
    )
  })

  it('pins the branch across path collisions and refuses a branch created after preflight', async () => {
    const f = await fixture()
    await mkdir(join(f.workspaceRoot, 'My-workspace'), { recursive: true })
    const picked = await f.candidate()
    expect(picked.worktreePath).toBe(join(f.workspaceRoot, 'My-workspace-2'))
    expect(picked.branchName).toBe(f.branch)
    await git(f.repoPath, 'branch', f.branch)
    await expect(
      addWorktree(f.repoPath, picked.worktreePath, picked.branchName, f.base, false, false, {
        trackRemoteBranch: true
      })
    ).rejects.toThrow()
    expect(await git(f.repoPath, 'rev-parse', `refs/heads/${f.branch}`)).toBe(f.initialTip)
    await expect(
      git(f.repoPath, 'rev-parse', '--verify', `refs/heads/${f.branch}-2`)
    ).rejects.toThrow()
  })

  it('keeps intentional branch-off creation separate from an available local branch', async () => {
    const f = await fixture()
    await git(f.repoPath, 'branch', f.branch)
    const picked = await f.create({ name: f.branch, branchIntent: 'create-new' })
    expect(picked.branchName).toBe(`${f.branch}-2`)
    expect(picked.checkoutExistingBranch).toBe(false)
    expect(await git(f.repoPath, 'rev-parse', `refs/heads/${f.branch}`)).toBe(f.initialTip)
    await expect(git(picked.worktreePath, 'rev-parse', '@{upstream}')).rejects.toThrow()
  })

  it('fails on a conflicting branch namespace without choosing a different name', async () => {
    const f = await fixture()
    await git(f.repoPath, 'branch', 'feature')
    await expect(f.create()).rejects.toThrow()
    expect(await git(f.repoPath, 'rev-parse', 'refs/heads/feature')).toBe(f.initialTip)
  })
})
