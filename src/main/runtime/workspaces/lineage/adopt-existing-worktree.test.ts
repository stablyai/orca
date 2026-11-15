import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitExecFileAsync } from '../../../git/command-runner/git-exec-file'
import {
  createStore,
  closeTestStores,
  makeRepo,
  testState
} from '../../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

async function fixture() {
  testState.dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-adopt-')))
  const main = join(testState.dir, 'main'),
    child = join(testState.dir, 'child')
  const git = (args: string[], cwd = testState.dir) => gitExecFileAsync(args, { cwd })
  await git(['init', '--quiet', main])
  await git(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'base'
    ],
    main
  )
  await git(['worktree', 'add', '-b', 'change', child], main)
  const store = createStore()
  store.addRepo(makeRepo({ id: 'repo', path: main, externalWorktreeVisibility: 'hide' }))
  const runtime = new OrcaRuntimeService(store)
  return { store, runtime, main, child, childId: `repo::${child}`, parent: `id:repo::${main}` }
}

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('imports a hidden real worktree, repairs either partial state, and is idempotent', async () => {
  const h = await fixture()
  const first = await h.runtime.adoptManagedExternalWorktree(h.child, h.parent)
  expect(first.status).toBe('adopted')
  expect(
    h.store.getRepos().find((repo) => repo.id === 'repo')?.importedExternalWorktreePaths
  ).toEqual([h.child])
  expect(h.store.getWorktreeLineage(h.childId)?.parentWorktreeId).toBe(`repo::${h.main}`)
  expect((await h.runtime.adoptManagedExternalWorktree(h.child, h.parent)).status).toBe(
    'already_adopted'
  )
  h.store.updateRepo(
    h.store.getRepos().find((repo) => repo.id === 'repo')!,
    { importedExternalWorktreePaths: [] }
  )
  expect((await h.runtime.adoptManagedExternalWorktree(h.child, h.parent)).status).toBe('adopted')
  h.store.removeWorktreeLineage(hostWorktreeTarget({ id: h.childId, hostId: 'local' }))
  expect((await h.runtime.adoptManagedExternalWorktree(h.child, h.parent)).status).toBe('adopted')
  await h.store.flushPendingOrThrowAsync()
  const restored = createStore()
  expect(restored.getWorktreeLineage(h.childId)?.parentWorktreeId).toBe(`repo::${h.main}`)
  expect(
    restored.getRepos().find((repo) => repo.id === 'repo')?.importedExternalWorktreePaths
  ).toEqual([h.child])
})

it('refuses the main checkout', async () => {
  const h = await fixture()
  await expect(h.runtime.adoptManagedExternalWorktree(h.main, h.parent)).rejects.toMatchObject({
    code: 'main_checkout'
  })
})

it.each(['legacy', 'workspace', 'cross-store'] as const)(
  'refuses foreign ownership in the %s map before importing visibility',
  async (map) => {
    const h = await fixture()
    await h.runtime.adoptManagedExternalWorktree(h.child, h.parent)
    const repo = h.store.getRepos().find((repo) => repo.id === 'repo')!
    h.store.updateRepo(repo, { importedExternalWorktreePaths: [] })
    if (map === 'legacy') {
      h.store.getAllWorktreeLineage()[h.childId]!.taskId = 'foreign'
      h.store.getAllWorktreeLineage()[h.childId]!.worktreeInstanceId = 'expired'
    }
    if (map === 'workspace') {
      h.store.getAllWorkspaceLineage()[`worktree:${h.childId}`]!.taskId = 'foreign'
    }
    if (map === 'cross-store') {
      h.store.setCrossStoreWorkspaceLineage(
        {
          childWorkspaceKey: `worktree:${h.childId}`,
          childInstanceId: h.store.getWorktreeMeta(h.childId)!.instanceId!,
          parent: {
            installationId: 'another-store',
            workspaceKey: `worktree:repo::${h.main}`,
            instanceId: 'foreign-parent'
          },
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 1,
          taskId: 'foreign'
        },
        'local'
      )
    }
    await expect(h.runtime.adoptManagedExternalWorktree(h.child, h.parent)).rejects.toMatchObject({
      code: 'ownership_conflict'
    })
    expect(
      h.store.getRepos().find((repo) => repo.id === 'repo')?.importedExternalWorktreePaths
    ).toEqual([])
  }
)

it('allows only one of two competing explicit parents', async () => {
  const h = await fixture()
  const other = join(testState.dir, 'other')
  await gitExecFileAsync(['worktree', 'add', '-b', 'other', other], { cwd: h.main })
  const results = await Promise.allSettled([
    h.runtime.adoptManagedExternalWorktree(h.child, h.parent),
    h.runtime.adoptManagedExternalWorktree(h.child, `id:repo::${other}`)
  ])
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect([`repo::${h.main}`, `repo::${other}`]).toContain(
    h.store.getWorktreeLineage(h.childId)?.parentWorktreeId
  )
})

it('restores lineage when importing visibility fails', async () => {
  const h = await fixture()
  vi.spyOn(h.store, 'updateRepo').mockImplementationOnce(() => {
    throw new Error('visibility failed')
  })
  await expect(h.runtime.adoptManagedExternalWorktree(h.child, h.parent)).rejects.toMatchObject({
    code: 'adopt_failed'
  })
  expect(h.store.getWorktreeLineage(h.childId)).toBeUndefined()
  expect(
    h.store.getRepos().find((repo) => repo.id === 'repo')?.importedExternalWorktreePaths ?? []
  ).toEqual([])
})
