import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn(async () => {})
}))
vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'

function gitInit(repoPath: string): void {
  execFileSync('git', ['init', '-q'], { cwd: repoPath, stdio: 'ignore' })
}

describe('OrcaRuntimeService folder-to-git promotion', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('promotes an existing folder after git init and explicit git re-add', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-promotion-'))
    roots.push(tempRoot)
    const repos: Record<string, unknown>[] = []
    const runtimeStore = {
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      getAllWorktreeMeta: () => ({}),
      getSettings: () => ({ workspaceDir: tempRoot, nestWorkspaces: false }),
      updateRepo: vi.fn((id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const folder = await runtime.addRepo(tempRoot, 'folder')
    runtimeStore.updateRepo(folder.id, {
      badgeColor: '#123456',
      projectHostSetupMethod: 'cloned'
    })
    runtimeStore.updateRepo.mockClear()
    gitInit(tempRoot)
    const readded = await runtime.addRepo(tempRoot, 'git')

    expect(folder.kind).toBe('folder')
    expect(readded).toMatchObject({
      id: folder.id,
      kind: 'git',
      badgeColor: '#123456',
      projectHostSetupMethod: 'cloned'
    })
    expect(repos).toHaveLength(1)
    expect(runtimeStore.updateRepo).toHaveBeenCalledWith(
      folder.id,
      expect.objectContaining({ kind: 'git' })
    )
    expect(prepareLocalWorktreeRootForRepo).toHaveBeenCalled()
  })

  it('does not reclassify a folder that never became a git repo', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-stays-folder-'))
    roots.push(tempRoot)
    await mkdir(join(tempRoot, 'notes'), { recursive: true })
    const repos: Record<string, unknown>[] = []
    const runtimeStore = {
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      getAllWorktreeMeta: () => ({}),
      getSettings: () => ({ workspaceDir: tempRoot, nestWorkspaces: false }),
      updateRepo: vi.fn()
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const folder = await runtime.addRepo(tempRoot, 'folder')
    await expect(runtime.addRepo(tempRoot, 'git')).rejects.toThrow('Not a valid git repository')

    expect(folder).toMatchObject({
      kind: 'folder',
      badgeColor: DEFAULT_REPO_BADGE_COLOR
    })
    expect(repos).toHaveLength(1)
    expect(runtimeStore.updateRepo).not.toHaveBeenCalled()
  })
})
