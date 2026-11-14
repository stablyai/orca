import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import 'node:path'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import 'node:os'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  TEST_REPO_ID,
  makeWorktreeInfo,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixtures.spec'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'

describe('OrcaRuntimeService', () => {
  it('refuses a reparent that closes a three-workspace loop through saved lineage', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'h']
    const [aId, bId, cId, dId, eId, fId, hId] = names.map(
      (name) => `${TEST_REPO_ID}::/tmp/worktree-${name}`
    )
    const gId = 'repo-remote::/remote/worktree-g'
    const metaById: Record<string, WorktreeMeta> = Object.fromEntries(
      [aId, bId, cId, dId, eId, fId, gId, hId].map((id) => [
        id,
        makeWorktreeMeta({ instanceId: `${id}-instance` })
      ])
    )
    const edge = (child: string, parent: string): WorktreeLineage => ({
      worktreeId: child,
      worktreeInstanceId: `${child}-instance`,
      parentWorktreeId: parent,
      parentWorktreeInstanceId: `${parent}-instance`,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    })
    const lineageById: Record<string, WorktreeLineage> = {
      [aId]: edge(aId, bId),
      [bId]: edge(bId, cId),
      [dId]: edge(dId, eId),
      [eId]: edge(eId, dId),
      // Legacy cross-host lineage must never be followed.
      [fId]: edge(fId, gId),
      [gId]: edge(gId, hId)
    }
    const setWorktreeLineage = vi.fn((_target: HostWorktreeTarget, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getRepos: () => [
        ...store.getRepos(),
        { id: 'repo-remote', path: '/remote', displayName: 'remote', connectionId: 'box' }
      ],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
      setWorktreeLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue(
      names.map((name) => makeWorktreeInfo(`/tmp/worktree-${name}`))
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    // Reparent invalidates resolved cache; lineage walks must not depend on it.
    await expect(
      runtime.updateManagedWorktreeMeta(`id:${cId}`, { lineage: { parentWorktree: `id:${aId}` } })
    ).rejects.toThrow('lineage cycle')
    expect(setWorktreeLineage).not.toHaveBeenCalled()

    for (const [childId, parentId] of [
      [cId, dId],
      [hId, fId]
    ]) {
      await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
        lineage: { parentWorktree: `id:${parentId}` }
      })
      expect(setWorktreeLineage).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: childId }),
        expect.objectContaining({ parentWorktreeId: parentId })
      )
    }
    expect(metaById[gId].hostId).toBeUndefined()
  })

  it('rotates a missing parent instance during runtime selector scans before same-path reuse', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'old-parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'old-parent-instance',
        origin: 'manual' as const,
        capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
        createdAt: 1
      }
    }
    const setWorktreeLineage = vi.fn((_target: HostWorktreeTarget, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage: vi.fn(({ id: worktreeId }: HostWorktreeTarget) => {
        delete lineageById[worktreeId]
      }),
      setWorktreeLineage
    }
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValue([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.showManagedWorktree(`id:${childId}`)
    const rotatedParentInstance = metaById[parentId].instanceId
    expect(rotatedParentInstance).toBeTruthy()
    expect(rotatedParentInstance).not.toBe('old-parent-instance')
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'rescanned' })
    expect(metaById[parentId].instanceId).toBe(rotatedParentInstance)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'touch' })
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: childId, hostId: 'local' }),
      expect.objectContaining({
        worktreeInstanceId: 'child-instance',
        parentWorktreeInstanceId: rotatedParentInstance
      })
    )
  })

  // #10562: renderer purges even after failed sweep; stale 30s scan rows would strand PTYs with no later retry.
  it('revalidates against a fresh scan instead of a warm worktree-scan cache', async () => {
    const deletedId = `${TEST_REPO_ID}::/tmp/deleted`
    const localProvider = {
      listProcesses: vi.fn(async () => [
        { id: `${deletedId}@@deleted-session`, cwd: '/tmp/deleted', title: 'shell' }
      ]),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getLocalProvider: () => localProvider as never
    })

    vi.mocked(listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/deleted', head: 'abc', branch: 'd', isBare: false, isMainWorktree: false }
    ])
    await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [deletedId])
    expect(localProvider.shutdown).not.toHaveBeenCalled()

    vi.mocked(listWorktrees).mockResolvedValue([])
    const result = await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [
      deletedId
    ])

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@deleted-session`,
      expect.objectContaining({ immediate: true })
    )
  })
})
