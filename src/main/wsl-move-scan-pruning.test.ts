import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type { ExecutionHostId } from '../shared/execution-host'
import type { WorktreeLineage } from '../shared/worktree/lineage-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import { closeTestStores, createStore, testState } from './persistence-test-harness'
import type { Store } from './persistence'
import { wslMoveCutoverFixture as cutover } from './persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from './persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from './persistence/moving-wsl-projects/wsl-move-scope-guard'
import { pruneLineageForMissingRepoWorktrees } from './worktree-lineage-pruning'
import { pruneMetadataMissingFromAuthoritativeLocalScan } from './ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning'
import { listFolderWorkspaces } from './ipc/worktrees/listing/folder-workspace-catalog'
import { getFolderWorkspaceRootId } from './ipc/worktrees/folder-workspace-model'
import { getLocalWorktreeScanGeneration } from './local-worktree-scan-generation'
import { listRuntimeFolderWorkspaces } from './runtime/runtime-worktree-filesystem'
import { getRuntimeFolderWorkspaceRootId } from './runtime/runtime-folder-workspace'
import { RuntimeWorktreeLineageController } from './runtime/runtime-worktree-lineage-controller'
import type { ResolvedWorktree } from './runtime/runtime-worktree-path-identity'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const MOVING = 'repo-1'
const STAYING = 'repo-2'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/ws/${id}`, displayName: id, badgeColor: '#000', addedAt: 0, ...overrides }
}
const onSsh: Partial<Repo> = { connectionId: 'target-1', executionHostId: 'ssh:target-1' }

function gitRow(path: string): GitWorktreeInfo {
  return { path, head: 'abc', branch: 'refs/heads/main', isBare: false, isMainWorktree: false }
}

function lineage(childId: string, parentId: string): WorktreeLineage {
  return {
    worktreeId: childId,
    worktreeInstanceId: `${childId}#instance`,
    parentWorktreeId: parentId,
    parentWorktreeInstanceId: `${parentId}#instance`,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

let store: Store
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-scan-'))
  store = createStore()
  store.addRepo(repo(MOVING))
  store.addRepo(repo(STAYING))
  loadWslMoveFence(testState.dir)
  seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
})
afterEach(async () => {
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('lineage pruning under a WSL move', () => {
  const pruneMissingChild = (target: Repo): WorktreeLineage | undefined => {
    const childId = `${target.id}::/ws/${target.id}/gone`
    store.setWorktreeLineage(childId, lineage(childId, `${target.id}::${target.path}`))
    pruneLineageForMissingRepoWorktrees(store, target, [gitRow(target.path)])
    return store.getWorktreeLineage(childId)
  }

  it('keeps the moving project lineage a mid-move scan cannot see', () => {
    expect(pruneMissingChild(repo(MOVING))).toBeDefined()
  })

  it('prunes a project the move is not taking', () => {
    expect(pruneMissingChild(repo(STAYING))).toBeUndefined()
  })

  it('prunes the same repo id on another host', () => {
    expect(pruneMissingChild(repo(MOVING, onSsh))).toBeUndefined()
  })
})

describe('authoritative metadata pruning under a WSL move', () => {
  const pruneMissingRow = async (repoId: string): Promise<string[]> => {
    const target = repo(repoId)
    const goneId = `${repoId}::/ws/${repoId}/gone`
    store.setWorktreeMeta(goneId, { displayName: 'gone' })
    const result = await pruneMetadataMissingFromAuthoritativeLocalScan({
      store,
      repo: target,
      gitWorktrees: [gitRow(target.path)],
      scan: store.captureNativeLocalWorktreeMetadataScanExpectation(target),
      scanGeneration: getLocalWorktreeScanGeneration(repoId),
      platform: 'linux',
      pathsExistOrAreUnverifiable: async (paths) => new Map(paths.map((path) => [path, false]))
    })
    return [...result.removedWorktreeIds]
  }

  it('removes nothing from the moving project', async () => {
    expect(await pruneMissingRow(MOVING)).toEqual([])
    expect(store.getWorktreeMeta(`${MOVING}::/ws/${MOVING}/gone`)).toBeDefined()
  })

  it('prunes a project the move is not taking', async () => {
    expect(await pruneMissingRow(STAYING)).toEqual([`${STAYING}::/ws/${STAYING}/gone`])
  })
})

describe('folder catalog identity stamps under a WSL move', () => {
  it('lists the moving folder project without writing its metadata', () => {
    const folder = repo(MOVING, { kind: 'folder' })
    expect(listFolderWorkspaces(store, folder).map((row) => row.id)).toEqual([
      getFolderWorkspaceRootId(folder)
    ])
    expect(store.getWorktreeMeta(getFolderWorkspaceRootId(folder))).toBeUndefined()

    const runtimeRows = listRuntimeFolderWorkspaces(store, folder)
    expect(runtimeRows).toHaveLength(1)
    expect(store.getWorktreeMeta(getRuntimeFolderWorkspaceRootId(folder))).toBeUndefined()
  })

  it('gives the moving root row the same identity on every listing', () => {
    const folder = repo(MOVING, { kind: 'folder' })
    const first = listFolderWorkspaces(store, folder)[0]?.instanceId
    const second = listFolderWorkspaces(store, folder)[0]?.instanceId
    expect(first).toBeTruthy()
    expect(second).toBe(first)
    expect(store.getWorktreeMeta(getFolderWorkspaceRootId(folder))).toBeUndefined()
  })

  it.each([
    ['a project the move is not taking', repo(STAYING, { kind: 'folder' })],
    ['the same repo id on another host', repo(MOVING, { kind: 'folder', ...onSsh })]
  ])('stamps %s', (_label, folder) => {
    listFolderWorkspaces(store, folder)
    expect(store.getWorktreeMeta(getFolderWorkspaceRootId(folder))?.instanceId).toBeTruthy()
  })

  it('stamps a runtime folder project the move is not taking', () => {
    const folder = repo(STAYING, { kind: 'folder' })
    listRuntimeFolderWorkspaces(store, folder)
    expect(store.getWorktreeMeta(getRuntimeFolderWorkspaceRootId(folder))?.instanceId).toBeTruthy()
  })
})

describe('inferred lineage hydration under a WSL move', () => {
  function resolved(repoId: string, name: string, hostId: ExecutionHostId, taskId?: string) {
    const path = `/ws/${repoId}/${name}`
    const worktree: ResolvedWorktree = {
      id: `${repoId}::${path}`,
      repoId,
      instanceId: `${repoId}-${hostId}-${name}#instance`,
      hostId,
      path,
      head: 'abc',
      branch: `refs/heads/${name}`,
      isBare: false,
      isMainWorktree: false,
      displayName: name,
      comment: taskId ? `working on ${taskId}` : '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { path, head: 'abc', branch: `refs/heads/${name}`, isBare: false, isMainWorktree: false }
    }
    return worktree
  }

  it('infers lineage only outside the moving local project', async () => {
    const children = [
      resolved(MOVING, 'child', 'local', 'task_moving'),
      resolved(STAYING, 'child', 'local', 'task_staying'),
      resolved(MOVING, 'child-remote', 'ssh:target-1', 'task_remote')
    ]
    const parents = new Map([
      ['task_moving', resolved(MOVING, 'parent', 'local')],
      ['task_staying', resolved(STAYING, 'parent', 'local')],
      ['task_remote', resolved(MOVING, 'parent-remote', 'ssh:target-1')]
    ])
    const controller = new RuntimeWorktreeLineageController({
      getStore: () => store,
      getCachedWorktrees: () => null,
      getDb: () => null,
      resolveWorktree: async () => {
        throw new Error('unused')
      },
      listResolvedWorktrees: async () => children,
      showTerminal: async () => {
        throw new Error('unused')
      }
    })
    vi.spyOn(controller, 'resolveTaskCandidate').mockImplementation(async (taskId) => {
      const parent = parents.get(taskId)
      return parent
        ? {
            source: 'orchestration-context',
            taskId,
            parent: {
              type: 'worktree',
              workspaceKey: worktreeWorkspaceKey(parent.id),
              worktree: parent,
              instanceId: parent.instanceId ?? null
            }
          }
        : null
    })

    await controller.hydrate()

    expect(store.getWorktreeLineage(children[0].id)).toBeUndefined()
    expect(store.getWorktreeLineage(children[1].id)?.parentWorktreeId).toBe(
      parents.get('task_staying')?.id
    )
    expect(store.getWorktreeLineage(children[2].id)?.parentWorktreeId).toBe(
      parents.get('task_remote')?.id
    )
  })
})
