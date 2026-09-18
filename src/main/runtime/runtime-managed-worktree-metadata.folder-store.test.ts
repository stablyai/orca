import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence'
import { createStore, makeRepo, makeWorktreeLineage, testState } from '../persistence-test-harness'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => []),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

let root: string
const stores: Store[] = []

function openStore(name: string): Store {
  testState.dir = join(root, name)
  mkdirSync(testState.dir, { recursive: true })
  const store = createStore()
  stores.push(store)
  return store
}

function createFolder(store: Store, name: string, connectionId: string | null = null) {
  const group = store.createProjectGroup({
    name,
    parentPath: join(root, 'workspace'),
    createdFrom: 'folder-scan',
    connectionId
  })
  return store.createFolderWorkspace({ projectGroupId: group.id, name, connectionId })
}

function child(store: Store, hostId: ExecutionHostId = 'local'): ResolvedWorktree {
  const repo = makeRepo({ path: join(root, 'repo') })
  store.addRepo(repo)
  const id = `${repo.id}::${join(repo.path, 'child')}`
  store.setWorktreeMetaForHost(id, hostId, { instanceId: 'child-instance', comment: 'unchanged' })
  return {
    id,
    repoId: repo.id,
    path: join(repo.path, 'child'),
    hostId,
    instanceId: 'child-instance'
  } as ResolvedWorktree
}

function metadataRuntime(store: Store, worktree: ResolvedWorktree) {
  // Store lookup/persistence are real; transport, Git discovery and UI notifications are outside this fixture.
  const resolveWorktree = vi.fn(async () => worktree)
  const lineage = new RuntimeWorktreeLineageController({
    getStore: () => store,
    getCachedWorktrees: () => [worktree],
    getDb: () => null,
    resolveWorktree,
    listResolvedWorktrees: async () => [worktree],
    showTerminal: async () => {
      throw new Error('No terminal in this fixture')
    }
  })
  return {
    lineage,
    attach: (parent: string) =>
      updateRuntimeManagedWorktreeMetadata({
        selector: `id:${worktree.id}`,
        updates: { comment: 'attached', lineage: { parentWorktree: parent } },
        store,
        ports: {
          resolveWorktree,
          resolveParent: (selector) => lineage.resolveParent(selector),
          validateParent: (target, parentWorktree) =>
            lineage.validateParent(target, parentWorktree),
          invalidateResolved: vi.fn(),
          invalidateScan: vi.fn(),
          notifyChanged: vi.fn(),
          showWorktree: async () => worktree
        }
      })
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-folder-lineage-'))
})
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  rmSync(root, { recursive: true, force: true })
})

describe('folder attachment through the runtime store', () => {
  it.each(['local', 'runtime:env-a', 'ssh:build-box'] as const)(
    'attaches a persisted folder for a %s child without a renderer host stamp',
    async (hostId) => {
      const store = openStore('owner')
      const folder = createFolder(store, 'Owner', hostId === 'ssh:build-box' ? 'build-box' : null)
      const worktree = child(store, hostId)
      store.setWorktreeLineage(worktree.id, makeWorktreeLineage({ worktreeId: worktree.id }))
      expect(folder).not.toHaveProperty('executionHostId')
      store.flush()
      store.freezeWrites()

      const restored = openStore('owner')
      const runtime = metadataRuntime(restored, worktree)
      const parent = await runtime.lineage.resolveParent(folderWorkspaceKey(folder.id))
      expect(parent).toMatchObject({ type: 'folder', folderWorkspace: { id: folder.id } })
      expect(parent.type === 'folder' && parent.folderWorkspace).not.toHaveProperty(
        'executionHostId'
      )
      expect(restored.getWorktreeLineage(worktree.id)).toMatchObject({ worktreeId: worktree.id })
      await runtime.attach(folderWorkspaceKey(folder.id))
      expect(restored.getWorktreeLineage(worktree.id)).toBeUndefined()
      expect(restored.getWorkspaceLineage(worktreeWorkspaceKey(worktree.id))).toMatchObject({
        childInstanceId: 'child-instance',
        parentWorkspaceKey: folderWorkspaceKey(folder.id),
        origin: 'manual'
      })
      restored.flush()
      restored.freezeWrites()
      expect(
        openStore('owner').getWorkspaceLineage(worktreeWorkspaceKey(worktree.id))
      ).toMatchObject({
        parentWorkspaceKey: folderWorkspaceKey(folder.id)
      })
    }
  )

  it('discards a renderer runtime stamp on load instead of treating it as folder authority', async () => {
    const store = openStore('owner')
    const folder = createFolder(store, 'Owner')
    const worktree = child(store, 'runtime:env-a')
    store.flush()
    store.freezeWrites()
    const file = join(root, 'owner', 'orca-data.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.folderWorkspaces[0].executionHostId = 'runtime:env-b'
    writeFileSync(file, JSON.stringify(saved))

    const restored = openStore('owner')
    expect(restored.getFolderWorkspaces()[0]).not.toHaveProperty('executionHostId')
    await metadataRuntime(restored, worktree).attach(folderWorkspaceKey(folder.id))
    expect(restored.getWorkspaceLineage(worktreeWorkspaceKey(worktree.id))).toMatchObject({
      parentWorkspaceKey: folderWorkspaceKey(folder.id)
    })
  })

  it('cannot attach a folder that exists only in another runtime store', async () => {
    const owner = openStore('owner')
    const worktree = child(owner, 'runtime:env-a')
    const previous = makeWorktreeLineage({ worktreeId: worktree.id })
    owner.setWorktreeLineage(worktree.id, previous)
    const other = openStore('other')
    const foreignFolder = createFolder(other, 'Other runtime')
    const otherReads = vi.spyOn(other, 'getFolderWorkspaces')
    const before = structuredClone(owner.getWorktreeMeta(worktree.id))
    expect(before).toMatchObject({ comment: 'unchanged' })

    await expect(
      metadataRuntime(owner, worktree).attach(folderWorkspaceKey(foreignFolder.id))
    ).rejects.toThrow('selector_not_found')
    expect(owner.getWorktreeLineage(worktree.id)).toEqual(previous)
    expect(owner.getWorktreeMeta(worktree.id)).toEqual(before)
    expect(owner.getAllWorkspaceLineage()).toEqual({})
    expect(other.getAllWorkspaceLineage()).toEqual({})
    expect(otherReads).not.toHaveBeenCalled()
  })

  it('resolves a colliding folder id only in the selected runtime store', async () => {
    const owner = openStore('owner')
    const folder = createFolder(owner, 'Owner folder')
    const worktree = child(owner, 'runtime:env-a')
    owner.flush()
    mkdirSync(join(root, 'other'), { recursive: true })
    writeFileSync(
      join(root, 'other', 'orca-data.json'),
      readFileSync(join(root, 'owner', 'orca-data.json'))
    )
    const other = openStore('other')
    other.updateFolderWorkspace(folder.id, { name: 'Other folder' })
    const runtime = metadataRuntime(owner, worktree)

    expect(await runtime.lineage.resolveParent(folderWorkspaceKey(folder.id))).toMatchObject({
      folderWorkspace: { name: 'Owner folder' }
    })
    await runtime.attach(folderWorkspaceKey(folder.id))
    expect(owner.getWorkspaceLineage(worktreeWorkspaceKey(worktree.id))).toMatchObject({
      parentWorkspaceKey: folderWorkspaceKey(folder.id)
    })
    expect(other.getAllWorkspaceLineage()).toEqual({})
    expect(other.getFolderWorkspaces()[0].name).toBe('Other folder')
  })

  it('still rejects an SSH folder for a runtime-local child without changing metadata or lineage', async () => {
    const store = openStore('owner')
    const folder = createFolder(store, 'SSH folder', 'build-box')
    const worktree = child(store, 'runtime:env-a')
    const previous = makeWorktreeLineage({ worktreeId: worktree.id })
    store.setWorktreeLineage(worktree.id, previous)
    const before = structuredClone(store.getWorktreeMeta(worktree.id))
    expect(before).toMatchObject({ comment: 'unchanged' })

    await expect(
      metadataRuntime(store, worktree).attach(folderWorkspaceKey(folder.id))
    ).rejects.toMatchObject({ code: 'LINEAGE_PARENT_CONTEXT_CONFLICT' })
    expect(store.getWorktreeLineage(worktree.id)).toEqual(previous)
    expect(store.getWorktreeMeta(worktree.id)).toEqual(before)
    expect(store.getAllWorkspaceLineage()).toEqual({})
  })
})
