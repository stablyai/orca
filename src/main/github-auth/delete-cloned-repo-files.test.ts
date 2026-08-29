import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'

const { trashItemMock } = vi.hoisted(() => ({ trashItemMock: vi.fn() }))

vi.mock('electron', () => ({
  shell: { trashItem: trashItemMock }
}))

import { deleteGitHubClonedRepoFiles } from './delete-cloned-repo-files'

const WORKSPACE_DIR = 'C:\\Users\\dev\\orca\\workspaces'
const CLONE_PARENT = 'C:\\Users\\dev\\orca\\projects'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: `${CLONE_PARENT}\\my-repo`,
    displayName: 'my-repo',
    badgeColor: '#000000',
    addedAt: 1,
    projectHostSetupMethod: 'cloned',
    ...overrides
  }
}

function makeStore(repo: Repo | undefined, settings?: { workspaceDir?: string }): Store {
  return {
    getRepo: vi.fn(() => repo),
    getSettings: vi.fn(() => settings ?? { workspaceDir: WORKSPACE_DIR })
  } as unknown as Store
}

beforeEach(() => {
  trashItemMock.mockReset()
  trashItemMock.mockResolvedValue(undefined)
})

describe('deleteGitHubClonedRepoFiles', () => {
  it('trashes a local clone inside the default clone parent', async () => {
    const repo = makeRepo()
    const result = await deleteGitHubClonedRepoFiles(makeStore(repo), repo.id)

    expect(result).toEqual({ ok: true })
    expect(trashItemMock).toHaveBeenCalledWith(repo.path)
  })

  it('refuses when the project does not exist', async () => {
    const result = await deleteGitHubClonedRepoFiles(makeStore(undefined), 'missing')

    expect(result).toEqual({ ok: false, error: 'Project not found.' })
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('refuses repos that were not cloned through Orca', async () => {
    const repo = makeRepo({ projectHostSetupMethod: 'imported-existing-folder' })
    const result = await deleteGitHubClonedRepoFiles(makeStore(repo), repo.id)

    expect(result.ok).toBe(false)
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('refuses remote repos even when the path string matches', async () => {
    const repo = makeRepo({ connectionId: 'ssh:some-host' })
    const result = await deleteGitHubClonedRepoFiles(makeStore(repo), repo.id)

    expect(result).toEqual({ ok: false, error: 'Only local clones can be cleaned up here.' })
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('refuses paths outside the clone parent', async () => {
    const repo = makeRepo({ path: 'C:\\Users\\dev\\elsewhere\\my-repo' })
    const result = await deleteGitHubClonedRepoFiles(makeStore(repo), repo.id)

    expect(result).toEqual({
      ok: false,
      error: 'Repository files are outside the clone directory.'
    })
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('refuses clones made under the pre-projects default location', async () => {
    const repo = makeRepo({ path: 'C:\\Users\\dev\\orca\\my-repo' })
    const result = await deleteGitHubClonedRepoFiles(makeStore(repo), repo.id)

    expect(result.ok).toBe(false)
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('trashes a clone under a POSIX workspace layout', async () => {
    const repo = makeRepo({ path: '/Users/dev/orca/projects/my-repo' })
    const store = makeStore(repo, { workspaceDir: '/Users/dev/orca/workspaces' })
    const result = await deleteGitHubClonedRepoFiles(store, repo.id)

    expect(result).toEqual({ ok: true })
    expect(trashItemMock).toHaveBeenCalledWith('/Users/dev/orca/projects/my-repo')
  })

  it('refuses when no workspace directory is configured', async () => {
    const repo = makeRepo()
    const result = await deleteGitHubClonedRepoFiles(makeStore(repo, {}), repo.id)

    expect(result.ok).toBe(false)
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('treats an already-deleted directory as success so the project can detach', async () => {
    trashItemMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    const repo = makeRepo()
    const result = await deleteGitHubClonedRepoFiles(makeStore(repo), repo.id)

    expect(result).toEqual({ ok: true })
  })

  it('surfaces other trash failures and keeps the project', async () => {
    trashItemMock.mockRejectedValue(new Error('access denied'))
    const repo = makeRepo()
    const result = await deleteGitHubClonedRepoFiles(makeStore(repo), repo.id)

    expect(result).toEqual({ ok: false, error: 'access denied' })
  })
})
