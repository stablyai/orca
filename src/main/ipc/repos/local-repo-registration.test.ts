import type * as FsPromises from 'node:fs/promises'
import type * as RepoIcons from '../../repo-icon-autodetect'
import type * as ProjectRealpathIdentity from '../../project-realpath-identity'
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence'
import { getDefaultSettings } from '../../../shared/constants'
import type { GitRepoRegistrationInfo } from '../../git/repo-detection'
import { inspectGitRepoForRegistrationAsync } from '../../git/repo'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { registrationGitLayout } from './local-registration-git.test-fixture'
import { findProjectAtSameRealPath } from '../../project-realpath-identity'
import { addLocalRepoFromPath } from './local-repo-registration'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return { ...actual, realpath: vi.fn(actual.realpath), stat: vi.fn(actual.stat) }
})
vi.mock('../../project-realpath-identity', async (original) => {
  const actual = await original<typeof ProjectRealpathIdentity>()
  return { ...actual, findProjectAtSameRealPath: vi.fn(actual.findProjectAtSameRealPath) }
})

vi.mock(import('../../git/repo'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    inspectGitRepoForRegistrationAsync: vi.fn(actual.inspectGitRepoForRegistrationAsync)
  }
})

vi.mock('../../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir'
const icons = await vi.importActual<typeof RepoIcons>('../../repo-icon-autodetect')

function createStore(repos: Repo[]): Store {
  const store = {
    getSettings: () => getDefaultSettings(tmpdir()),
    getRepos: () => repos,
    addRepo: (repo: Repo) => {
      repos.push(repo)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration and its Git-refusal diagnostic use getRepos/addRepo/getSettings; root preparation is mocked.
  return store as unknown as Store
}

describe('addLocalRepoFromPath through a symlink alias', () => {
  let root: string

  beforeEach(async () => {
    vi.clearAllMocks()
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-local-add-alias-')))
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
      vi.mocked(detectRepoIconAndUpstream).mockImplementationOnce(icons.detectRepoIconAndUpstream)
      vi.mocked(stat).mockClear()
      vi.mocked(realpath).mockClear()
      const reads = vi.spyOn(store, 'getRepos')
      const adds = vi.spyOn(store, 'addRepo')
      const results = await Promise.all(
        Array.from({ length: q }, (_, i) =>
          addLocalRepoFromPath(store, i % 2 ? path : alias, 'folder', 'Chats')
        )
      )
      expect(detectRepoIconAndUpstream).toHaveBeenCalledOnce()
      expect(adds).toHaveBeenCalledOnce()
      expect(vi.mocked(stat).mock.calls.length).toBeGreaterThan(0)
      expect(vi.mocked(stat).mock.calls.length).toBeLessThanOrEqual(40)
      expect(reads.mock.calls.length).toBeLessThan(15 * q)
      expect(vi.mocked(realpath).mock.calls.length).toBeLessThan(4 * q)
      expect(
        vi.mocked(realpath).mock.calls.every(([path]) => !String(path).startsWith('/foreign'))
      ).toBe(true)
      expect(inspectGitRepoForRegistrationAsync).not.toHaveBeenCalled()
      process.stdout.write(
        `registration work ${JSON.stringify({
          q,
          discovery: 1,
          iconStats: vi.mocked(stat).mock.calls.length,
          inserts: adds.mock.calls.length,
          lookups: reads.mock.calls.length,
          realpaths: vi.mocked(realpath).mock.calls.length
        })}\n`
      )
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
  it.each(['folder', 'git'] as const)(
    'completes %s reuse and fresh removal re-entry while the old creator still prepares',
    async (kind) => {
      const layout = kind === 'git' ? await registrationGitLayout(root, false) : null
      const path = layout?.input ?? join(root, 'chats')
      if (!layout) {
        await mkdir(path)
      }
      const repos: Repo[] = []
      const store = createStore(repos)
      const preparation = Promise.withResolvers<void>()
      vi.mocked(prepareLocalWorktreeRootForRepo).mockReturnValueOnce(preparation.promise)
      const old = addLocalRepoFromPath(store, path, kind)
      try {
        await vi.waitFor(() => expect(repos).toHaveLength(1))
        const oldId = repos[0].id
        await expect(addLocalRepoFromPath(store, path, kind)).resolves.toMatchObject({
          repo: { id: oldId },
          alreadyExisted: true
        })
        repos.splice(0)
        const fresh = await addLocalRepoFromPath(store, path, kind)
        expect(fresh).toMatchObject({ repo: { path: layout?.main ?? path }, alreadyExisted: false })
        expect(repos[0].id).not.toBe(oldId)
        preparation.resolve()
        await expect(old).resolves.toMatchObject({
          error: 'The project was removed while it was being added.'
        })
        expect(repos).toHaveLength(1)
        await expect(addLocalRepoFromPath(store, path, kind)).resolves.toMatchObject({
          alreadyExisted: true
        })
      } finally {
        preparation.resolve()
        await Promise.allSettled([old])
      }
    }
  )

  it('uses the current replacement when Git validation has not selected a project yet', async () => {
    const path = join(root, 'chats')
    await mkdir(path)
    const repos: Repo[] = []
    const store = createStore(repos)
    const created = await addLocalRepoFromPath(store, path, 'folder')
    const validation = Promise.withResolvers<GitRepoRegistrationInfo>()
    vi.mocked(inspectGitRepoForRegistrationAsync).mockReturnValueOnce(validation.promise)
    const joining = addLocalRepoFromPath(store, path, 'git')
    try {
      await vi.waitFor(() => expect(inspectGitRepoForRegistrationAsync).toHaveBeenCalledOnce())
      repos.splice(0)
      const replacement = await addLocalRepoFromPath(store, path, 'folder')
      expect(
        'repo' in created && 'repo' in replacement && created.repo.id !== replacement.repo.id
      ).toBe(true)
      validation.resolve({ isRepo: true, rootPath: path, mainRepoPath: null })
      await expect(joining).resolves.toMatchObject({ ...replacement, alreadyExisted: true })
      expect(repos).toHaveLength(1)
      expect(detectRepoIconAndUpstream).toHaveBeenCalledTimes(2)
    } finally {
      validation.resolve({ isRepo: true, rootPath: path, mainRepoPath: null })
      await Promise.allSettled([joining])
    }
  })

  it('retires its own realpath-selected ID without substituting a same-path replacement', async () => {
    const path = join(root, 'chats'),
      alias = join(root, 'alias')
    await mkdir(path)
    await symlink(path, alias, dirLinkType)
    const repos: Repo[] = []
    const store = createStore(repos)
    await addLocalRepoFromPath(store, path, 'folder')
    const lookup = vi.mocked(findProjectAtSameRealPath).getMockImplementation()!
    const selected = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    vi.mocked(findProjectAtSameRealPath).mockImplementationOnce(async (...args) => {
      const row = await lookup(...args)
      selected.resolve()
      await release.promise
      return row
    })
    const old = addLocalRepoFromPath(store, alias, 'folder')
    try {
      await selected.promise
      const oldId = repos[0].id
      repos.splice(0)
      await addLocalRepoFromPath(store, path, 'folder')
      expect(repos[0].id).not.toBe(oldId)
      release.resolve()
      await expect(old).resolves.toMatchObject({
        error: 'The project was removed while it was being added.'
      })
      expect(repos).toHaveLength(1)
    } finally {
      release.resolve()
      await Promise.allSettled([old])
    }
  })

  it.each([true, false])(
    'keeps folder progress independent of held Git inspection (linked=%s)',
    async (linked) => {
      const { main, input } = await registrationGitLayout(root, linked)
      const repos: Repo[] = [],
        store = createStore(repos)
      const inspection = vi.mocked(inspectGitRepoForRegistrationAsync).getMockImplementation()!
      const facts = await inspection(input)
      const validation = Promise.withResolvers<GitRepoRegistrationInfo>()
      vi.mocked(inspectGitRepoForRegistrationAsync)
        .mockClear()
        .mockReturnValueOnce(validation.promise)
      const git = addLocalRepoFromPath(store, input, 'git')
      try {
        await vi.waitFor(() => expect(inspectGitRepoForRegistrationAsync).toHaveBeenCalledOnce())
        await expect(addLocalRepoFromPath(store, input, 'folder')).resolves.toMatchObject({
          repo: { path: input, kind: 'folder' },
          alreadyExisted: false
        })
        validation.resolve(facts)
        await expect(git).resolves.toMatchObject({
          repo: { path: input, kind: 'folder' },
          alreadyExisted: true
        })
        expect(repos).toHaveLength(1)
        expect(main).not.toBe(input)
      } finally {
        validation.resolve(facts)
        await Promise.allSettled([git])
      }
    }
  )

  it.each([true, false])(
    'resolves own Git result after a folder at its input is removed (linked=%s)',
    async (linked) => {
      const { main, input } = await registrationGitLayout(root, linked)
      const repos: Repo[] = [],
        store = createStore(repos)
      const parent = await addLocalRepoFromPath(store, main, 'git')
      const preparation = Promise.withResolvers<void>()
      vi.mocked(prepareLocalWorktreeRootForRepo).mockReturnValueOnce(preparation.promise)
      const folder = addLocalRepoFromPath(store, input, 'folder')
      const inspection = vi.mocked(inspectGitRepoForRegistrationAsync).getMockImplementation()!
      const facts = await inspection(input)
      const validation = Promise.withResolvers<GitRepoRegistrationInfo>()
      vi.mocked(inspectGitRepoForRegistrationAsync)
        .mockClear()
        .mockReturnValueOnce(validation.promise)
      const git = addLocalRepoFromPath(store, input, 'git')
      try {
        await vi.waitFor(() => expect(repos).toHaveLength(2))
        await vi.waitFor(() => expect(inspectGitRepoForRegistrationAsync).toHaveBeenCalledOnce())
        repos.splice(
          repos.findIndex((repo) => repo.path === input),
          1
        )
        validation.resolve(facts)
        await expect(git).resolves.toMatchObject({ ...parent, alreadyExisted: true })
        preparation.resolve()
        await expect(folder).resolves.toHaveProperty('error')
        expect(repos).toHaveLength(1)
      } finally {
        validation.resolve(facts)
        preparation.resolve()
        await Promise.allSettled([folder, git])
      }
    }
  )

  it.each([true, false])(
    'uses current Git resolution after the resolved project is removed (linked=%s)',
    async (linked) => {
      const { main, input } = await registrationGitLayout(root, linked)
      const repos: Repo[] = [],
        store = createStore(repos)
      await addLocalRepoFromPath(store, main, 'git')
      const inspection = vi.mocked(inspectGitRepoForRegistrationAsync).getMockImplementation()!
      const facts = await inspection(input)
      const validation = Promise.withResolvers<GitRepoRegistrationInfo>()
      vi.mocked(inspectGitRepoForRegistrationAsync).mockReturnValueOnce(validation.promise)
      const git = addLocalRepoFromPath(store, input, 'git')
      try {
        repos.splice(0)
        validation.resolve(facts)
        await expect(git).resolves.toMatchObject({
          repo: { path: linked ? input : main, kind: 'git' },
          alreadyExisted: false
        })
        expect(repos).toHaveLength(1)
      } finally {
        validation.resolve(facts)
        await Promise.allSettled([git])
      }
    }
  )

  it('shares one discovery for valid Git and folder requests at an aliased Git root', async () => {
    const { main } = await registrationGitLayout(root, false)
    const alias = join(root, 'main-alias')
    await symlink(main, alias, dirLinkType)
    const repos: Repo[] = [],
      store = createStore(repos)
    const results = await Promise.all([
      addLocalRepoFromPath(store, main, 'git'),
      addLocalRepoFromPath(store, alias, 'folder')
    ])
    expect(repos).toHaveLength(1)
    expect(results.filter((result) => 'repo' in result && result.alreadyExisted)).toHaveLength(1)
    expect(results.filter((result) => 'repo' in result && !result.alreadyExisted)).toHaveLength(1)
    expect(detectRepoIconAndUpstream).toHaveBeenCalledOnce()
    expect(new Set(results.map((result) => 'repo' in result && result.repo.id)).size).toBe(1)
  })

  it.each([false, true])(
    'settles a successor after held discovery releases (reject=%s)',
    async (reject) => {
      const path = join(root, 'chats')
      await mkdir(path)
      const repos: Repo[] = [],
        store = createStore(repos)
      const discovery = Promise.withResolvers<object>()
      vi.mocked(detectRepoIconAndUpstream).mockReturnValueOnce(discovery.promise)
      const first = addLocalRepoFromPath(store, path, 'folder')
      const settledFirst = Promise.allSettled([first])
      await vi.waitFor(() => expect(detectRepoIconAndUpstream).toHaveBeenCalledOnce())
      const second = addLocalRepoFromPath(store, path, 'folder')
      try {
        const independent = join(root, 'independent')
        await mkdir(independent)
        await expect(addLocalRepoFromPath(store, independent, 'folder')).resolves.toMatchObject({
          repo: { path: independent },
          alreadyExisted: false
        })
        if (reject) {
          discovery.reject(new Error('discovery unavailable'))
        } else {
          discovery.resolve({})
        }
        await expect(second).resolves.toMatchObject({ repo: { path }, alreadyExisted: !reject })
        expect((await settledFirst)[0].status).toBe(reject ? 'rejected' : 'fulfilled')
        expect(repos.filter((repo) => repo.path === path)).toHaveLength(1)
        expect(repos).toHaveLength(2)
        expect(detectRepoIconAndUpstream).toHaveBeenCalledTimes(reject ? 3 : 2)
        await expect(addLocalRepoFromPath(store, path, 'folder')).resolves.toMatchObject({
          alreadyExisted: true
        })
      } finally {
        discovery.resolve({})
        await Promise.allSettled([first, second])
      }
    }
  )
})

it.each([false, true])(
  'keeps plain-folder Git refusal separate in either order (folderFirst=%s)',
  async (folderFirst) => {
    const path = await mkdtemp(join(tmpdir(), 'orca-mixed-kind-'))
    try {
      const repos: Repo[] = []
      const store = createStore(repos)
      const calls = folderFirst ? (['folder', 'git'] as const) : (['git', 'folder'] as const)
      const results = await Promise.all(
        calls.map((kind) => addLocalRepoFromPath(store, path, kind))
      )
      const git = results[folderFirst ? 1 : 0],
        folder = results[folderFirst ? 0 : 1]
      expect(git).toMatchObject({ error: expect.stringContaining('Not a valid git repository') })
      expect(folder).toMatchObject({ repo: { path, kind: 'folder' }, alreadyExisted: false })
      expect(repos).toHaveLength(1)
    } finally {
      await rm(path, { recursive: true, force: true })
    }
  }
)
