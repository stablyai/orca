import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { addLocalRepoFromPath } from './local-repo-registration'

vi.mock('../../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir'

function createStore(repos: Repo[]): Store {
  const store = {
    getRepos: () => repos,
    addRepo: (repo: Repo) => {
      repos.push(repo)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: addLocalRepoFromPath only calls getRepos/addRepo.
  return store as unknown as Store
}

describe('addLocalRepoFromPath through a symlink alias', () => {
  let root: string

  beforeEach(async () => {
    vi.clearAllMocks()
    root = await mkdtemp(join(tmpdir(), 'orca-local-add-alias-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns the tracked folder workspace instead of adding a duplicate', async () => {
    const folderPath = join(root, 'notes')
    await mkdir(folderPath)
    await symlink(folderPath, join(root, 'notes-link'), dirLinkType)
    const repos: Repo[] = []
    const store = createStore(repos)

    const first = await addLocalRepoFromPath(store, folderPath, 'folder')
    const second = await addLocalRepoFromPath(store, join(root, 'notes-link'), 'folder')

    expect('repo' in first && 'repo' in second && second.repo.id === first.repo.id).toBe(true)
    expect(second).toMatchObject({ alreadyExisted: true })
    expect(repos).toHaveLength(1)
  })

  it('registers one folder when two quick chat requests add it concurrently', async () => {
    const path = join(root, 'chats')
    await mkdir(path)
    const repos: Repo[] = []
    const store = createStore(repos)
    const [first, second] = await Promise.all([
      addLocalRepoFromPath(store, path, 'folder', 'Chats'),
      addLocalRepoFromPath(store, path, 'folder', 'Chats')
    ])
    expect(repos).toHaveLength(1)
    expect('repo' in first && 'repo' in second && first.repo.id === second.repo.id).toBe(true)
  })

  it('keeps two different folders as two workspaces', async () => {
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    const repos: Repo[] = []
    const store = createStore(repos)

    await addLocalRepoFromPath(store, join(root, 'a'), 'folder')
    await addLocalRepoFromPath(store, join(root, 'b'), 'folder')

    expect(repos).toHaveLength(2)
  })
  it.each([10, 100])(
    'shares one canonical discovery across %s cold window/alias callers, then retires removed identity',
    async (q) => {
      const path = join(root, 'chats')
      const alias = join(root, 'alias')
      await mkdir(path)
      await symlink(path, alias, dirLinkType)
      const repos: Repo[] = []
      const store = createStore(repos)
      const foreign: Repo = {
        id: 'peer',
        path,
        displayName: 'Remote',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'folder',
        executionHostId: 'runtime:peer'
      }
      repos.push(foreign)
      const results = await Promise.all(
        Array.from({ length: q }, (_, i) =>
          addLocalRepoFromPath(store, i % 2 ? path : alias, 'folder', 'Chats')
        )
      )
      expect(detectRepoIconAndUpstream).toHaveBeenCalledOnce()
      expect(results.filter((result) => 'repo' in result && !result.alreadyExisted)).toHaveLength(1)
      expect(results.filter((result) => 'repo' in result && result.alreadyExisted)).toHaveLength(
        q - 1
      )
      expect(repos).toHaveLength(2)
      expect(
        new Set(results.map((result) => ('repo' in result ? result.repo.id : result.error))).size
      ).toBe(1)
      const local = repos[1]
      local.displayName = 'Customized'
      expect(await addLocalRepoFromPath(store, path, 'folder')).toMatchObject({
        repo: { id: local.id, displayName: 'Customized' }
      })
      repos.splice(1)
      expect(await addLocalRepoFromPath(store, path, 'folder')).toMatchObject({
        repo: { displayName: 'chats' }
      })
      expect(repos[1].id).not.toBe(local.id)
    }
  )
  it('ends a removed registration and allows a fresh action after the in-flight failure', async () => {
    const path = join(root, 'chats')
    await mkdir(path)
    const repos: Repo[] = []
    const store = createStore(repos)
    let release = () => {}
    vi.mocked(prepareLocalWorktreeRootForRepo).mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve()
      })
    )
    const old = addLocalRepoFromPath(store, path, 'folder')
    await vi.waitFor(() => expect(repos).toHaveLength(1))
    const reads = vi.spyOn(store, 'getRepos')
    const joining = addLocalRepoFromPath(store, path, 'folder')
    await vi.waitFor(() => expect(reads).toHaveBeenCalled())
    repos.splice(0)
    await expect(addLocalRepoFromPath(store, path, 'folder')).resolves.toHaveProperty('repo')
    release()
    await expect(old).resolves.toHaveProperty('error')
    await expect(joining).resolves.toMatchObject({
      error: 'The project was removed while it was being added.'
    })
    await expect(addLocalRepoFromPath(store, path, 'folder')).resolves.toHaveProperty('repo')
  })
})

it('gives a valid folder caller its own outcome after a plain-folder Git caller refuses', async () => {
  const path = await mkdtemp(join(tmpdir(), 'orca-mixed-kind-'))
  try {
    const repos: Repo[] = []
    const store = createStore(repos)
    const [git, folder] = await Promise.all([
      addLocalRepoFromPath(store, path, 'git'),
      addLocalRepoFromPath(store, path, 'folder')
    ])
    expect(git).toMatchObject({ error: expect.stringContaining('Not a valid git repository') })
    expect(folder).toMatchObject({ repo: { path, kind: 'folder' }, alreadyExisted: false })
    expect(repos).toHaveLength(1)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})
