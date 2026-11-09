import {
  closeTestStores,
  testState,
  createStore,
  makeRepo,
  writeDataFile,
  makeProject,
  makeProjectHostSetup,
  readPersistedState
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsUpdate } from '../../../shared/rpc-contract/client-settings-params'
import { getDefaultPersistedState } from '../../../shared/constants'
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

describe('project-scoped persisted lineage', () => {
  const child = 'repo-a::/workspace/child'
  const foreign = 'repo-b::/workspace/parent'
  const sibling = 'repo-c::/workspace/sibling'
  const edge = (id: string, parent: string): WorktreeLineage => ({
    worktreeId: id,
    worktreeInstanceId: id,
    parentWorktreeId: parent,
    parentWorktreeInstanceId: parent,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  })
  function seed(
    links: Record<string, WorktreeLineage> = { [child]: edge(child, foreign) },
    thirdInB = false
  ) {
    const defaults = getDefaultPersistedState(testState.dir)
    writeDataFile({
      ...defaults,
      repos: ['a', 'b', 'c'].map((id) =>
        makeRepo({
          id: `repo-${id}`,
          path: `/repos/${id}`,
          upstream: {
            owner: 'example',
            repo: id === 'b' || (id === 'c' && thirdInB) ? 'project-b' : 'project-a'
          }
        })
      ),
      projects: [
        makeProject({
          id: 'github:example/project-a',
          sourceRepoIds: thirdInB ? ['repo-a'] : ['repo-a', 'repo-c']
        }),
        makeProject({
          id: 'github:example/project-b',
          sourceRepoIds: thirdInB ? ['repo-b', 'repo-c'] : ['repo-b']
        })
      ],
      projectHostSetups: ['a', 'b', 'c'].map((id) =>
        makeProjectHostSetup({
          id: `repo-${id}`,
          repoId: `repo-${id}`,
          projectId:
            id === 'b' || (id === 'c' && thirdInB)
              ? 'github:example/project-b'
              : 'github:example/project-a',
          path: `/repos/${id}`
        })
      ),
      worktreeMeta: Object.fromEntries(
        [
          [child, 'a'],
          [foreign, 'b'],
          [sibling, 'c']
        ].map(([id, repo]) => [
          id,
          {
            instanceId: id,
            hostId: 'local',
            projectId:
              repo === 'b' || (repo === 'c' && thirdInB)
                ? 'github:example/project-b'
                : 'github:example/project-a',
            projectHostSetupId: `repo-${repo}`,
            comment: 'original'
          }
        ])
      ),
      worktreeLineageById: links,
      workspaceLineageByChildKey: Object.fromEntries(
        Object.entries(links).map(([id, row]) => [
          `worktree:${id}`,
          {
            childWorkspaceKey: `worktree:${id}`,
            childInstanceId: id,
            parentWorkspaceKey: `worktree:${row.parentWorktreeId}`,
            parentInstanceId: row.parentWorktreeInstanceId,
            origin: row.origin,
            capture: row.capture,
            createdAt: row.createdAt
          }
        ])
      ),
      settings: { ...defaults.settings, workspaceLineagePolicy: 'same-project' }
    })
  }
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-project-lineage-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('withholds every public graph form and restores the saved foreign edge on rollback', async () => {
    seed()
    const store = createStore()
    expect(store.getWorktreeLineage(child)).toBeUndefined()
    expect(store.getAllWorktreeLineage()).toEqual({})
    expect(store.getWorkspaceLineage(`worktree:${child}`)).toBeUndefined()
    expect(store.getAllWorkspaceLineage()).toEqual({})
    store.updateSettings({ workspaceLineagePolicy: 'any-project' })
    expect(store.getWorktreeLineage(child)?.parentWorktreeId).toBe(foreign)
    await store.freezeWritesAsync()
    expect(readPersistedState().worktreeLineageById[child]).toEqual(edge(child, foreign))
  })

  it('rejects a foreign replacement before touching the saved relationship maps', async () => {
    seed({ [child]: edge(child, sibling) })
    const store = createStore()
    expect(() =>
      store.setWorktreeLineage(
        hostWorktreeTarget({ id: child, hostId: 'local' }),
        edge(child, foreign)
      )
    ).toThrow()
    expect(store.getWorktreeLineage(child)?.parentWorktreeId).toBe(sibling)
    expect(store.getWorkspaceLineage(`worktree:${child}`)?.parentWorkspaceKey).toBe(
      `worktree:${sibling}`
    )
  })

  it('keeps same-project nesting across different repository and setup IDs', () => {
    seed({})
    const store = createStore()
    expect(
      store
        .getProjectHostSetups()
        .filter((setup) => setup.projectId === 'github:example/project-a')
        .map((setup) => setup.id)
        .sort()
    ).toEqual(['repo-a', 'repo-c'])
    store.setWorktreeLineage(
      hostWorktreeTarget({ id: child, hostId: 'local' }),
      edge(child, sibling)
    )
    expect(store.getWorktreeLineage(child)?.parentWorktreeId).toBe(sibling)
  })

  it('does not replace a hidden saved parent with an allowed inferred parent', async () => {
    seed()
    const store = createStore()
    store.setWorktreeLineage(hostWorktreeTarget({ id: child, hostId: 'local' }), {
      ...edge(child, sibling),
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' }
    })
    store.updateSettings({ workspaceLineagePolicy: 'any-project' })
    expect(store.getWorktreeLineage(child)?.parentWorktreeId).toBe(foreign)
    await store.freezeWritesAsync()
    expect(readPersistedState().worktreeLineageById[child]).toEqual(edge(child, foreign))
  })

  it('rejects a cycle through hidden persisted edges and preserves rollback', () => {
    // Z(B) -> X(A) -> Y(B), request Y(B) -> Z(B).
    seed({ [foreign]: edge(foreign, child), [child]: edge(child, sibling) }, true)
    const store = createStore()
    expect(() =>
      store.setWorktreeLineage(
        hostWorktreeTarget({ id: sibling, hostId: 'local' }),
        edge(sibling, foreign)
      )
    ).toThrow(expect.objectContaining({ code: 'LINEAGE_PARENT_CYCLE' }))
    store.updateSettings({ workspaceLineagePolicy: 'any-project' })
    expect(store.getWorktreeLineage(foreign)).toEqual(edge(foreign, child))
    expect(store.getWorktreeLineage(child)).toEqual(edge(child, sibling))
    expect(store.getWorktreeLineage(sibling)).toBeUndefined()
  })

  it('accepts only the supported policy values at the settings RPC boundary', () => {
    expect(SettingsUpdate.parse({ workspaceLineagePolicy: 'same-project' })).toEqual({
      workspaceLineagePolicy: 'same-project'
    })
    expect(SettingsUpdate.safeParse({ workspaceLineagePolicy: 'unknown' }).success).toBe(false)
  })

  it('retains hidden original records during automatic load reconciliation', async () => {
    seed({
      [child]: {
        ...edge(child, foreign),
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'inferred' }
      }
    })
    const saved = readPersistedState()
    saved.workspaceLineageByChildKey[`worktree:${child}`] = {
      childWorkspaceKey: `worktree:${child}`,
      childInstanceId: child,
      parentWorkspaceKey: 'folder:legacy-group',
      parentInstanceId: 'legacy-group',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
    writeDataFile(saved)
    const store = createStore()
    expect(store.getAllWorktreeLineage()).toEqual({})
    store.updateSettings({ workspaceLineagePolicy: 'any-project' })
    expect(store.getWorktreeLineage(child)).toEqual(saved.worktreeLineageById[child])
    store.updateSettings({ workspaceLineagePolicy: 'same-project' })
    // Dirty the actual lineage domains, not merely an unrelated settings row.
    store.setWorktreeLineage(
      hostWorktreeTarget({ id: sibling, hostId: 'local' }),
      edge(sibling, child)
    )
    await store.freezeWritesAsync()
    const after = readPersistedState()
    expect(after.worktreeLineageById[child]).toEqual(saved.worktreeLineageById[child])
    expect(after.workspaceLineageByChildKey[`worktree:${child}`]).toEqual(
      saved.workspaceLineageByChildKey[`worktree:${child}`]
    )
    const reloaded = createStore()
    reloaded.updateSettings({ workspaceLineagePolicy: 'any-project' })
    expect(reloaded.getWorktreeLineage(child)).toEqual(saved.worktreeLineageById[child])
  })

  it('retains the instance-aware raw cycle guard through an unstamped intermediate host', () => {
    seed({ [foreign]: edge(foreign, child), [child]: edge(child, sibling) }, true)
    const saved = readPersistedState()
    delete saved.worktreeMeta[child].hostId
    for (const meta of Object.values(saved.worktreeMetaByIdentity ?? {})) {
      if (meta.instanceId === child) {
        delete meta.hostId
      }
    }
    writeDataFile(saved)
    const store = createStore()
    expect(() =>
      store.setWorktreeLineage(
        hostWorktreeTarget({ id: sibling, hostId: 'local' }),
        edge(sibling, foreign)
      )
    ).toThrow(expect.objectContaining({ code: 'LINEAGE_PARENT_CYCLE' }))
  })
})
