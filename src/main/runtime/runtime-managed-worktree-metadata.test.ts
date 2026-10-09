import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

const directories: string[] = []
const stores: Store[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flushPendingOrThrowAsync()))
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openStore(kind: 'folder' | 'git', hostId: ExecutionHostId) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  stores.push(store)
  const repo = {
    id: 'repo-1',
    path: join(directory, 'project'),
    kind,
    displayName: 'Project',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: hostId
  }
  store.addRepo(repo)
  return { store, repo, dataFile }
}

function resolvedWorktree(
  store: Store,
  repo: ReturnType<typeof openStore>['repo'],
  hostId: ExecutionHostId,
  suffix = ''
): ResolvedWorktree {
  const id = `${repo.id}::${repo.path}${suffix}`
  const meta = store.getWorktreeMetaForHost(id, hostId)
  if (!meta?.instanceId) {
    throw new Error('fixture_missing_instance')
  }
  const git = {
    path: repo.path,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false
  }
  return {
    ...meta,
    ...git,
    id,
    repoId: repo.id,
    hostId,
    identity: createWorktreeIdentity({
      worktreeId: id,
      executionHostId: hostId,
      instanceId: meta.instanceId
    }),
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git
  }
}

function deferred<T>() {
  let complete: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    complete = resolve
  })
  return {
    promise,
    resolve: (value: T) => {
      if (!complete) {
        throw new Error('fixture_not_ready')
      }
      complete(value)
    }
  }
}

function ports(worktree: ResolvedWorktree) {
  return {
    resolveWorktree: vi.fn(async () => worktree),
    validateParent: vi.fn(),
    invalidateResolved: vi.fn(),
    invalidateScan: vi.fn(),
    notifyChanged: vi.fn(),
    showWorktree: vi.fn(async () => worktree)
  }
}

describe('runtime metadata occupant admission', () => {
  it.each([
    { kind: 'folder', hostId: 'local' },
    { kind: 'folder', hostId: 'ssh:build-box' },
    { kind: 'git', hostId: 'local' },
    { kind: 'git', hostId: 'ssh:build-box' }
  ] as const)(
    'rejects a delayed $kind update after remove/re-add on $hostId',
    async ({ kind, hostId }) => {
      const { store, repo, dataFile } = openStore(kind, hostId)
      const suffix = kind === 'folder' ? '::workspace:11111111-1111-4111-8111-111111111111' : ''
      const id = `${repo.id}::${repo.path}${suffix}`
      store.setWorktreeMetaForHost(id, hostId, { instanceId: 'old-instance', comment: 'old' })
      store.setWorktreeMetaForHost(id, 'runtime:sibling', {
        instanceId: 'sibling-instance',
        comment: 'untouched'
      })
      const old = resolvedWorktree(store, repo, hostId, suffix)
      const gate = deferred<ResolvedWorktree>()
      const calls = ports(old)
      calls.resolveWorktree.mockImplementation(() => gate.promise)
      const pending = updateRuntimeManagedWorktreeMetadata({
        selector: `identity:${old.identity?.key}`,
        updates: { comment: 'late' },
        store,
        ports: calls
      })
      const rejected = expect(pending).rejects.toThrow('selector_not_found')
      store.removeWorktreeMeta(id, hostId)
      const replacement = store.setWorktreeMetaForHost(id, hostId, {
        instanceId: 'new-instance',
        comment: 'new'
      })
      const sibling = structuredClone(store.getWorktreeMetaForHost(id, 'runtime:sibling'))
      gate.resolve(old)
      await rejected
      expect(store.getWorktreeMetaForHost(id, hostId)).toEqual(replacement)
      expect(store.getWorktreeMetaForHost(id, 'runtime:sibling')).toEqual(sibling)
      expect(calls.invalidateResolved).not.toHaveBeenCalled()
      expect(calls.invalidateScan).not.toHaveBeenCalled()
      expect(calls.notifyChanged).not.toHaveBeenCalled()
      expect(calls.showWorktree).not.toHaveBeenCalled()
      store.flushOrThrow()
      const reopened = createSqliteTestStore(Store, { dataFile })
      stores.push(reopened)
      expect(reopened.getWorktreeMetaForHost(id, hostId)).toEqual(replacement)
      expect(reopened.getWorktreeMetaForHost(id, 'runtime:sibling')).toEqual(sibling)
    }
  )

  it.each(['child', 'parent'] as const)(
    'rechecks the %s occupant after awaiting a lineage parent',
    async (removed) => {
      const { store, repo } = openStore('git', 'local')
      const childId = `${repo.id}::${repo.path}`
      const parentId = `${childId}-parent`
      store.setWorktreeMetaForHost(childId, 'local', { instanceId: 'child-old', comment: 'child' })
      store.setWorktreeMetaForHost(parentId, 'local', {
        instanceId: 'parent-old',
        comment: 'parent'
      })
      const child = resolvedWorktree(store, repo, 'local')
      const parent = resolvedWorktree(store, repo, 'local', '-parent')
      const gate = deferred<ResolvedWorktree>()
      const calls = ports(child)
      calls.resolveWorktree.mockResolvedValueOnce(child).mockImplementationOnce(() => gate.promise)
      const pending = updateRuntimeManagedWorktreeMetadata({
        selector: `id:${childId}`,
        updates: { comment: 'late', lineage: { parentWorktree: `id:${parentId}` } },
        store,
        ports: calls
      })
      const rejected = expect(pending).rejects.toThrow('selector_not_found')
      await vi.waitFor(() => expect(calls.resolveWorktree).toHaveBeenCalledTimes(2))
      const invalidateCount = calls.invalidateResolved.mock.calls.length
      const removedId = removed === 'child' ? childId : parentId
      store.removeWorktreeMeta(removedId, 'local')
      store.setWorktreeMetaForHost(removedId, 'local', {
        instanceId: `${removed}-new`,
        comment: 'replacement'
      })
      const childBefore = structuredClone(store.getWorktreeMetaForHost(childId, 'local'))
      const parentBefore = structuredClone(store.getWorktreeMetaForHost(parentId, 'local'))
      gate.resolve(parent)
      await rejected
      expect(store.getWorktreeMetaForHost(childId, 'local')).toEqual(childBefore)
      expect(store.getWorktreeMetaForHost(parentId, 'local')).toEqual(parentBefore)
      expect(store.getAllWorktreeLineage()).toEqual({})
      expect(store.getAllWorkspaceLineage()).toEqual({})
      expect(calls.validateParent).not.toHaveBeenCalled()
      expect(calls.invalidateResolved).toHaveBeenCalledTimes(invalidateCount)
      expect(calls.notifyChanged).not.toHaveBeenCalled()
      expect(calls.showWorktree).not.toHaveBeenCalled()
    }
  )

  it('updates an existing SSH occupant and retains its exact selector for the returned row', async () => {
    const { store, repo } = openStore('git', 'ssh:build-box')
    const id = `${repo.id}::${repo.path}`
    store.setWorktreeMetaForHost(id, 'local', { instanceId: 'local-instance', comment: 'local' })
    store.setWorktreeMetaForHost(id, 'ssh:build-box', {
      instanceId: 'remote-instance',
      comment: 'before'
    })
    const remote = resolvedWorktree(store, repo, 'ssh:build-box')
    const localBefore = structuredClone(store.getWorktreeMetaForHost(id, 'local'))
    const calls = ports(remote)
    await updateRuntimeManagedWorktreeMetadata({
      selector: `identity:${remote.identity?.key}`,
      updates: { comment: 'remote only' },
      store,
      ports: calls
    })
    expect(store.getWorktreeMetaForHost(id, 'ssh:build-box')?.comment).toBe('remote only')
    expect(store.getWorktreeMetaForHost(id, 'local')).toEqual(localBefore)
    expect(calls.notifyChanged).toHaveBeenCalledExactlyOnceWith(repo.id)
    expect(calls.showWorktree).toHaveBeenCalledExactlyOnceWith(`identity:${remote.identity?.key}`)
  })
})
