import {
  closeTestStores,
  testState,
  createStore,
  makeRepo,
  writeDataFile
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({})
}))

const CHILD = 'repo-a::/workspace/child'
const PARENT = 'repo-a::/workspace/parent'
const OTHER_PARENT = 'repo-a::/workspace/other'
const local = hostWorktreeTarget({ id: CHILD, hostId: 'local' })

const worktreeParent = (parentWorktreeId: string): WorktreeLineage => ({
  worktreeId: CHILD,
  worktreeInstanceId: 'child-instance',
  parentWorktreeId,
  parentWorktreeInstanceId: `${parentWorktreeId}-instance`,
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 1
})

const folderParent: WorkspaceLineage = {
  childWorkspaceKey: `worktree:${CHILD}`,
  childInstanceId: 'child-instance',
  parentWorkspaceKey: 'folder:feature',
  parentInstanceId: null,
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 2
}

describe('worktree parent records', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-single-parent-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps one parent when a worktree moves between worktree and folder parents', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'repo-a', path: '/workspace/repo-a' }))

    store.setWorktreeLineage(local, worktreeParent(PARENT))
    expect(store.getWorkspaceLineage(`worktree:${CHILD}`)?.parentWorkspaceKey).toBe(
      `worktree:${PARENT}`
    )

    store.setFolderParentLineage(local, folderParent)
    expect(store.getWorktreeLineage(CHILD)).toBeUndefined()
    expect(store.getWorkspaceLineage(`worktree:${CHILD}`)?.parentWorkspaceKey).toBe(
      'folder:feature'
    )

    store.setWorktreeLineage(local, worktreeParent(OTHER_PARENT))
    expect(store.getWorktreeLineage(CHILD)?.parentWorktreeId).toBe(OTHER_PARENT)
    expect(store.getWorkspaceLineage(`worktree:${CHILD}`)?.parentWorkspaceKey).toBe(
      `worktree:${OTHER_PARENT}`
    )
  })

  it("leaves a same-id twin's parent alone when another host owns the id", async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'repo-a', path: '/workspace/repo-a' }))
    const twin = hostWorktreeTarget({ id: CHILD, hostId: 'runtime:env-a' })
    store.setWorktreeMeta(twin, { displayName: 'Twin' })
    store.setWorktreeLineage(twin, worktreeParent(PARENT))

    expect(store.setFolderParentLineage(local, folderParent)).toBeUndefined()
    expect(store.getWorktreeLineage(CHILD)?.parentWorktreeId).toBe(PARENT)
    expect(store.getWorkspaceLineage(`worktree:${CHILD}`)?.parentWorkspaceKey).toBe(
      `worktree:${PARENT}`
    )
  })

  const hydrateCapture = {
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'inferred' }
  } as const
  const envCapture = {
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' }
  } as const
  const manualCapture = {
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' }
  } as const

  it.each([
    ['explicit folder, hydrate worktree parent', manualCapture, hydrateCapture, false],
    ['explicit folder, inferred worktree parent', manualCapture, envCapture, false],
    ['inferred folder, hydrate worktree parent', envCapture, hydrateCapture, false],
    ['inferred folder, inferred worktree parent', envCapture, envCapture, true],
    ['explicit folder, explicit worktree parent', manualCapture, manualCapture, true]
  ] as const)('loads %s', async (_, folder, legacy, kept) => {
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: 'repo-a', path: '/workspace/repo-a' })],
      worktreeMeta: {},
      worktreeLineageById: { [CHILD]: { ...worktreeParent(PARENT), ...legacy } },
      workspaceLineageByChildKey: { [`worktree:${CHILD}`]: { ...folderParent, ...folder } }
    })

    const store = await createStore()

    expect(store.getWorktreeLineage(CHILD)?.parentWorktreeId).toBe(kept ? PARENT : undefined)
    expect(store.getWorkspaceLineage(`worktree:${CHILD}`)).toMatchObject({
      parentWorkspaceKey: 'folder:feature',
      capture: folder.capture
    })
  })
})
