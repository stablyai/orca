import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  testState,
  writeDataFile,
  makeRepo,
  makeProject,
  makeProjectHostSetup,
  readPersistedState
} from '../../../persistence/persistence-test-harness'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult
} from '../../../../shared/worktree/create-types'

const ipc = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, args: CreateWorktreeArgs) => Promise<CreateWorktreeResult>
  >()
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir, isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] },
  ipcMain: {
    handle: (
      name: string,
      callback: (event: unknown, args: CreateWorktreeArgs) => Promise<CreateWorktreeResult>
    ) => ipc.handlers.set(name, callback),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn(), isTelemetryEnabled: () => false }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => [],
  sshConfigHostsToTargets: () => []
}))
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { RuntimeWorktreeLineageController } from '../../../runtime/workspaces/lineage/runtime-worktree-lineage-controller'
import { recordCreatedWorktreeLineage } from '../../../runtime/workspaces/lineage/runtime-worktree-lineage-recording'
import { registerWorktreeCreateHandlers } from './register-worktree-create-handlers'
import { recordWorkspaceLineageForCreatedWorktree } from '../../worktree-remote'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

function fixture(policy: 'same-project' | 'any-project' = 'same-project', thirdInB = false) {
  const defaults = getDefaultPersistedState(testState.dir)
  writeDataFile({
    ...defaults,
    repos: ['a', 'b', 'c'].map((id) =>
      makeRepo({
        id: `repo-${id}`,
        path: `/folders/${id}`,
        kind: 'folder',
        upstream: {
          owner: 'example',
          repo: id === 'b' || (id === 'c' && thirdInB) ? 'project-b' : 'project-a'
        }
      })
    ),
    projects: ['a', 'b'].map((id) =>
      makeProject({
        id: `github:example/project-${id}`,
        sourceRepoIds: [`repo-${id}`],
        kind: 'folder'
      })
    ),
    projectHostSetups: ['a', 'b', 'c'].map((id) =>
      makeProjectHostSetup({
        id: `repo-${id}`,
        repoId: `repo-${id}`,
        projectId:
          id === 'b' || (id === 'c' && thirdInB)
            ? 'github:example/project-b'
            : 'github:example/project-a',
        path: `/folders/${id}`,
        kind: 'folder'
      })
    ),
    worktreeMeta: {
      'repo-c::/folders/c': {
        instanceId: 'parent-c',
        hostId: 'local',
        projectId: thirdInB ? 'github:example/project-b' : 'github:example/project-a',
        projectHostSetupId: 'repo-c',
        comment: 'C'
      },
      'repo-b::/folders/b': {
        instanceId: 'parent-b',
        hostId: 'local',
        projectId: 'github:example/project-b',
        projectHostSetupId: 'repo-b',
        comment: 'parent comment'
      },
      'repo-a::/folders/a': {
        projectId: 'github:example/project-a',
        projectHostSetupId: 'repo-a',
        comment: 'legacy unstamped'
      }
    },
    settings: { ...defaults.settings, workspaceLineagePolicy: policy }
  })
  const store = createStore()
  const runtime = new OrcaRuntimeService(store)
  const mainWindow = { isDestroyed: () => true }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creation reads only this window stub and the real Store/runtime; removal-only context fields are unused.
  registerWorktreeCreateHandlers({ mainWindow, store, runtime } as unknown as WorktreeIpcContext)
  return {
    store,
    runtime,
    create: (args: CreateWorktreeArgs) => ipc.handlers.get('worktrees:create')!({}, args)
  }
}

describe('native folder IPC project admission', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-project-ipc-'))
    ipc.handlers.clear()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('refuses an explicit foreign parent before folder registration or legacy identity migration', async () => {
    const { store, create } = fixture()
    store.flushOrThrow()
    const before = readPersistedState()
    await expect(
      create({
        repoId: 'repo-a',
        name: 'child',
        parentWorkspace: 'worktree:repo-b::/folders/b',
        comment: 'keep this'
      })
    ).rejects.toMatchObject({ code: 'LINEAGE_PARENT_CONTEXT_CONFLICT' })
    store.flushOrThrow()
    const after = readPersistedState()
    for (const key of [
      'worktreeMeta',
      'worktreeMetaByIdentity',
      'worktreeIdentityAliases',
      'worktreeLineageById',
      'workspaceLineageByChildKey',
      'crossStoreLineageByChildKey',
      'folderWorkspaces'
    ] as const) {
      expect(after[key]).toEqual(before[key])
    }
  })

  it('persists the original folder comment without inventing parent semantics', async () => {
    const { store, create } = fixture()
    const result = await create({
      repoId: 'repo-a',
      name: 'root',
      comment: 'original operator note'
    })
    expect(store.getProjectHostSetups().find((setup) => setup.id === 'repo-a')).toMatchObject({
      projectId: 'github:example/project-a',
      repoId: 'repo-a',
      hostId: 'local'
    })
    expect(result.worktree.projectId).toBe('github:example/project-a')
    expect(result.worktree.projectHostSetupId).toBe('repo-a')
    expect(result.worktree.comment).toBe('original operator note')
    expect(store.getWorktreeLineage(result.worktree.id)).toBeUndefined()
  })

  it('supports same-project folder reparenting across authoritative repo/setup identities', async () => {
    const { store, runtime, create } = fixture()
    const child = await create({ repoId: 'repo-a', name: 'child' })
    expect(store.getProjectHostSetups().find((setup) => setup.id === 'repo-c')).toMatchObject({
      projectId: 'github:example/project-a',
      repoId: 'repo-c'
    })
    await runtime.updateManagedWorktreeMeta(`id:${child.worktree.id}`, {
      lineage: { parentWorktree: 'id:repo-c::/folders/c' }
    })
    expect(store.getWorktreeLineage(child.worktree.id)?.parentWorktreeId).toBe('repo-c::/folders/c')
    expect(store.getWorkspaceLineage(`worktree:${child.worktree.id}`)?.parentWorkspaceKey).toBe(
      'worktree:repo-c::/folders/c'
    )
  })

  it('refuses cold-cache reparenting without stamping legacy identities or partially editing metadata', async () => {
    const { store, runtime } = fixture()
    store.flushOrThrow()
    const before = readPersistedState()
    await expect(
      runtime.updateManagedWorktreeMeta('id:repo-a::/folders/a', {
        comment: 'must not persist',
        lineage: { parentWorktree: 'id:repo-b::/folders/b' }
      })
    ).rejects.toMatchObject({ code: 'LINEAGE_PARENT_CONTEXT_CONFLICT' })
    store.flushOrThrow()
    const after = readPersistedState()
    for (const key of [
      'worktreeMeta',
      'worktreeMetaByIdentity',
      'worktreeIdentityAliases',
      'worktreeLineageById',
      'workspaceLineageByChildKey',
      'crossStoreLineageByChildKey',
      'folderWorkspaces'
    ] as const) {
      expect(after[key]).toEqual(before[key])
    }
  })

  it('rejects a runtime cycle through hidden raw edges before a combined metadata write', async () => {
    const { store, runtime } = fixture('any-project', true)
    store.setWorktreeMeta(hostWorktreeTarget({ id: 'repo-a::/folders/a', hostId: 'local' }), {
      instanceId: 'instance-a',
      hostId: 'local'
    })
    const edge = (id: string, instanceId: string, parent: string, parentInstance: string) => ({
      worktreeId: id,
      worktreeInstanceId: instanceId,
      parentWorktreeId: parent,
      parentWorktreeInstanceId: parentInstance,
      origin: 'manual' as const,
      capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
      createdAt: 1
    })
    store.setWorktreeLineage(
      hostWorktreeTarget({ id: 'repo-b::/folders/b', hostId: 'local' }),
      edge('repo-b::/folders/b', 'parent-b', 'repo-a::/folders/a', 'instance-a')
    )
    store.setWorktreeLineage(
      hostWorktreeTarget({ id: 'repo-a::/folders/a', hostId: 'local' }),
      edge('repo-a::/folders/a', 'instance-a', 'repo-c::/folders/c', 'parent-c')
    )
    store.updateSettings({ workspaceLineagePolicy: 'same-project' })
    store.flushOrThrow()
    const before = readPersistedState()
    await expect(
      runtime.updateManagedWorktreeMeta('id:repo-c::/folders/c', {
        comment: 'must not persist',
        lineage: { parentWorktree: 'id:repo-b::/folders/b' }
      })
    ).rejects.toMatchObject({ code: 'LINEAGE_PARENT_CYCLE' })
    store.flushOrThrow()
    const after = readPersistedState()
    expect(after.worktreeLineageById).toEqual(before.worktreeLineageById)
    expect(after.workspaceLineageByChildKey).toEqual(before.workspaceLineageByChildKey)
    expect(after.worktreeMetaByIdentity).toEqual(before.worktreeMetaByIdentity)
    store.updateSettings({ workspaceLineagePolicy: 'any-project' })
    expect(store.getWorktreeLineage('repo-b::/folders/b')?.parentWorktreeId).toBe(
      'repo-a::/folders/a'
    )
    expect(store.getWorktreeLineage('repo-a::/folders/a')?.parentWorktreeId).toBe(
      'repo-c::/folders/c'
    )
  })

  it('creates an inferred foreign context as the requested root with original comment and references', async () => {
    const { store, runtime } = fixture()
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-a',
      name: 'inferred',
      activate: false,
      setupOnly: true,
      comment: 'original operator note',
      lineage: {
        envParentWorkspace: 'id:repo-b::/folders/b',
        orchestrationContext: {
          coordinatorHandle: 'term_coordinator',
          taskId: 'task_dependency',
          orchestrationRunId: 'run_original'
        }
      }
    })
    expect(result.worktree.projectId).toBe('github:example/project-a')
    expect(result.worktree.comment).toMatch(/^original operator note\n\n/)
    expect(result.worktree.comment).toContain('worktree:repo-b::/folders/b')
    expect(result.worktree.comment).toContain('term_coordinator')
    expect(result.warnings?.[0].code).toBe('LINEAGE_PARENT_CONTEXT_CONFLICT')
    expect(store.getWorktreeLineage(result.worktree.id)).toBeUndefined()
  })

  it.each(['any-project', 'same-project'] as const)(
    'creates a root-only folder despite an ambiguous inferred cwd under %s',
    async (policy) => {
      const { store, runtime } = fixture(policy)
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-a',
        name: 'ambiguous-cwd-root',
        activate: false,
        setupOnly: true,
        comment: 'original ambiguous note',
        lineage: { cwdParentWorktree: 'id:repo-c::/folders/c', cwdParentAmbiguous: true }
      })
      expect(result.worktree.projectId).toBe('github:example/project-a')
      expect(result.worktree.comment).toMatch(/^original ambiguous note/)
      expect(result.lineage).toBeUndefined()
      expect(store.getWorktreeLineage(result.worktree.id)).toBeUndefined()
      if (policy === 'same-project') {
        expect(result.warnings).toContainEqual(
          expect.objectContaining({ code: 'LINEAGE_PARENT_CONTEXT_MISSING' })
        )
      }
    }
  )

  it('still refuses an ambiguous explicit folder-create parent when cwd is ambiguous too', async () => {
    const { runtime } = fixture()
    vi.spyOn(RuntimeWorktreeLineageController.prototype, 'resolveWorktreeParent').mockRejectedValue(
      new Error('selector_ambiguous')
    )
    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'id:repo-a',
        name: 'explicit-ambiguous-parent',
        activate: false,
        setupOnly: true,
        lineage: {
          parentWorktree: 'name:ambiguous',
          cwdParentWorktree: 'id:repo-c::/folders/c',
          cwdParentAmbiguous: true
        }
      })
    ).rejects.toMatchObject({ code: 'LINEAGE_PARENT_AMBIGUOUS' })
  })

  it('omits an inferred cross-store parent without requiring this store identity and retains context', async () => {
    const { store, runtime } = fixture()
    vi.spyOn(
      RuntimeWorktreeLineageController.prototype,
      'readStoreInstallationId'
    ).mockResolvedValue(undefined)
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-a',
      name: 'cross-store-root',
      activate: false,
      setupOnly: true,
      comment: 'original cross-store note',
      lineage: {
        crossStoreParent: {
          installationId: 'other-install',
          workspaceKey: 'worktree:other::/parent',
          instanceId: 'other-parent'
        },
        crossStoreParentInferredFrom: 'terminal-context',
        callerTerminalHandle: 'term_original',
        orchestrationContext: {
          coordinatorHandle: 'term_coordinator',
          taskId: 'task_dependency',
          orchestrationRunId: 'run_original'
        }
      }
    })
    expect(result.worktree.projectId).toBe('github:example/project-a')
    expect(result.worktree.comment).toMatch(/^original cross-store note\n\n/)
    expect(result.worktree.comment).toContain('other-install')
    expect(result.worktree.comment).toContain('task_dependency')
    expect(result.worktree.comment).toContain('term_original')
    expect(result.warnings?.[0].code).toBe('LINEAGE_PARENT_CONTEXT_CONFLICT')
    expect(store.getAllCrossStoreWorkspaceLineage()).toEqual({})
  })

  it.each(['native', 'runtime', 'reparent'] as const)(
    'keeps all cold legacy Git state unchanged on invalid explicit %s admission',
    async (route) => {
      const paths = { a: join(testState.dir, 'git-a'), b: join(testState.dir, 'git-b') }
      for (const path of Object.values(paths)) {
        mkdirSync(path)
        execFileSync('git', ['init'], { cwd: path, stdio: 'ignore' })
        execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: path })
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            'commit',
            '--allow-empty',
            '-m',
            'fixture'
          ],
          { cwd: path, stdio: 'ignore' }
        )
      }
      const defaults = getDefaultPersistedState(testState.dir)
      const child = `repo-a::${paths.a}`
      const parent = `repo-b::${paths.b}`
      const missing = `repo-b::${join(testState.dir, 'missing-checkout')}`
      const legacy = {
        worktreeId: missing,
        worktreeInstanceId: 'missing-instance',
        parentWorktreeId: parent,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
      writeDataFile({
        ...defaults,
        repos: ['a', 'b'].map((id) =>
          makeRepo({
            id: `repo-${id}`,
            path: id === 'a' ? paths.a : paths.b,
            upstream: { owner: 'example', repo: `project-${id}` }
          })
        ),
        worktreeMeta: {
          [child]: {
            projectId: 'github:example/project-a',
            projectHostSetupId: 'repo-a',
            comment: 'legacy without host or instance'
          },
          [parent]: {
            instanceId: 'parent-instance',
            hostId: 'local',
            projectId: 'github:example/project-b',
            projectHostSetupId: 'repo-b'
          },
          [missing]: {
            instanceId: 'missing-instance',
            hostId: 'local',
            projectId: 'github:example/project-b',
            projectHostSetupId: 'repo-b'
          }
        },
        worktreeLineageById: { [missing]: legacy },
        workspaceLineageByChildKey: {
          [`worktree:${missing}`]: {
            childWorkspaceKey: `worktree:${missing}`,
            childInstanceId: 'missing-instance',
            parentWorkspaceKey: `worktree:${parent}`,
            parentInstanceId: 'parent-instance',
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: 1
          }
        },
        settings: {
          ...defaults.settings,
          workspaceDir: join(testState.dir, 'created'),
          workspaceLineagePolicy: 'same-project'
        }
      })
      const store = createStore()
      const runtime = new OrcaRuntimeService(store)
      const context = { mainWindow: { isDestroyed: () => true }, store, runtime }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creation reads only this window stub and the real Store/runtime; removal-only context fields are unused.
      registerWorktreeCreateHandlers(context as unknown as WorktreeIpcContext)
      store.flushOrThrow()
      const before = readPersistedState()
      const operation =
        route === 'reparent'
          ? runtime.updateManagedWorktreeMeta(`id:${child}`, {
              comment: 'must not persist',
              lineage: { parentWorktree: `id:${parent}` }
            })
          : route === 'native'
            ? ipc.handlers.get('worktrees:create')!(
                {},
                {
                  repoId: 'repo-a',
                  name: 'forbidden',
                  parentWorkspace: `worktree:${parent}`,
                  comment: 'preserve'
                }
              )
            : runtime.createManagedWorktree({
                repoSelector: 'id:repo-a',
                name: 'forbidden',
                comment: 'preserve',
                lineage: { parentWorktree: `id:${parent}` },
                activate: false,
                setupOnly: true
              })
      await expect(operation).rejects.toMatchObject({ code: 'LINEAGE_PARENT_CONTEXT_CONFLICT' })
      store.flushOrThrow()
      const after = readPersistedState()
      for (const key of [
        'worktreeMeta',
        'worktreeMetaByIdentity',
        'worktreeIdentityAliases',
        'worktreeLineageById',
        'workspaceLineageByChildKey',
        'crossStoreLineageByChildKey',
        'folderWorkspaces',
        'repos',
        'projects',
        'projectHostSetups'
      ] as const) {
        expect(after[key]).toEqual(before[key])
      }
      expect(existsSync(join(testState.dir, 'created'))).toBe(false)
    }
  )

  it('advertises the policy capability and effective host-owned setting', () => {
    const { runtime } = fixture()
    expect(runtime.getStatus()).toMatchObject({
      workspaceLineagePolicy: 'same-project',
      capabilities: expect.arrayContaining(['workspace.lineage-policy.v1'])
    })
    expect(runtime.getClientSettings().workspaceLineagePolicy).toBe('same-project')
  })

  it('reports a same-project parent on root-only native folder creation without claiming it was recorded', async () => {
    const { store, create } = fixture()
    const result = await create({
      repoId: 'repo-a',
      name: 'root-only',
      parentWorkspace: 'worktree:repo-c::/folders/c',
      comment: 'original'
    })
    expect(result.worktree.projectId).toBe('github:example/project-a')
    expect(result.worktree.comment).toMatch(/^original\n\n/)
    expect(result.warnings?.[0].code).toBe('LINEAGE_PARENT_CONTEXT_MISSING')
    expect(store.getWorktreeLineage(result.worktree.id)).toBeUndefined()
  })

  it.each(['policy', 'ownership', 'policy-without-resolution'] as const)(
    'keeps a native explicit-parent create as root after a %s change',
    async (change) => {
      const { store, runtime, create } = fixture(
        change === 'ownership' ? 'same-project' : 'any-project'
      )
      const parent = change === 'ownership' ? 'repo-c::/folders/c' : 'repo-b::/folders/b'
      const created = await create({
        repoId: 'repo-a',
        name: 'native-created',
        comment: 'original native note'
      })
      const resolution = await runtime.resolveLineageForWorktreeCreate(
        { parentWorkspace: `worktree:${parent}`, parentWorkspaceOrigin: 'manual' },
        store.getRepo('repo-a')!
      )
      expect(resolution.kind).toBe('lineage')
      if (change !== 'ownership') {
        store.updateSettings({ workspaceLineagePolicy: 'same-project' })
      } else {
        store.setWorktreeMeta(hostWorktreeTarget({ id: parent, hostId: 'local' }), {
          projectId: 'github:example/project-b'
        })
      }
      const result = recordWorkspaceLineageForCreatedWorktree(
        store,
        { repoId: 'repo-a', name: 'native-created', parentWorkspace: `worktree:${parent}` },
        created.worktree,
        1,
        change === 'policy-without-resolution' ? undefined : resolution
      )
      expect(result.lineage).toBeNull()
      expect(result.workspaceLineage).toBeNull()
      expect(result.warnings?.[0].code).toBe('LINEAGE_PARENT_CONTEXT_CONFLICT')
      expect(store.getWorktreeLineage(created.worktree.id)).toBeUndefined()
      expect(store.getWorktreeMeta(created.worktree.id)?.comment).toMatch(
        /^original native note\n\n/
      )
    }
  )

  it('keeps a created workspace as a root if policy changes before lineage persistence', async () => {
    const { store, runtime, create } = fixture('any-project')
    const created = await create({
      repoId: 'repo-a',
      name: 'created',
      comment: 'original operator note'
    })
    const resolution = await runtime.resolveLineageForWorktreeCreate(
      { parentWorkspace: 'worktree:repo-b::/folders/b', parentWorkspaceOrigin: 'manual' },
      store.getRepo('repo-a')!
    )
    expect(resolution.kind).toBe('lineage')
    store.updateSettings({ workspaceLineagePolicy: 'same-project' })
    const result = recordCreatedWorktreeLineage(store, created.worktree, resolution)
    expect(result.warnings[0]?.code).toBe('LINEAGE_PARENT_CONTEXT_CONFLICT')
    expect(store.getWorktreeLineage(created.worktree.id)).toBeUndefined()
    const comment = store.getWorktreeMeta(created.worktree.id)?.comment
    expect(comment).toMatch(/^original operator note\n\n/)
    expect(comment).toContain('worktree:repo-b::/folders/b')
  })
})
