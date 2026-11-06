import {
  closeTestStores,
  createSqliteTestStore,
  createStore as createFreshStore,
  testState
} from '../persistence-test-harness'
// Repo IDs can repeat across execution hosts; row deletion must preserve sibling registrations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { resetRetirementCollisionKeyCacheForTests } from '../../workspaces/removal/retirement/worktree-name-retirement'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

let hasCreatedStoreInCase = false

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

function duplicateIdRepos(): Repo[] {
  return [
    {
      id: 'dup',
      path: '/laptop/dup',
      displayName: 'Dup Local',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local'
    } as Repo,
    {
      id: 'dup',
      path: '/remote/dup',
      displayName: 'Dup Remote',
      badgeColor: '#000',
      addedAt: 2,
      connectionId: 'ssh-1'
    } as Repo
  ]
}

async function createStoreFromState(state: Record<string, unknown>) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), ...state }),
    'utf-8'
  )
  if (!hasCreatedStoreInCase) {
    hasCreatedStoreInCase = true
    return createFreshStore()
  }
  vi.resetModules()
  const { Store } = await import('../loading-store/store')
  const { initDataPath } = await import('../loading-store/user-data-path')
  // resetModules replaces AppEnvironment; reinstall this test’s userData path before initializing.
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

function createStoreWithDuplicateRepoId() {
  return createStoreFromState({ repos: duplicateIdRepos() })
}

function staleLocalSetupState() {
  const project: Project = {
    id: 'project-dup',
    displayName: 'Dup',
    badgeColor: '#000',
    sourceRepoIds: ['dup'],
    createdAt: 1,
    updatedAt: 1
  }
  const setup: ProjectHostSetup = {
    id: 'project-dup::local',
    projectId: project.id,
    hostId: 'local',
    repoId: 'dup',
    path: '/laptop/dup',
    displayName: 'Dup Local',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1
  }
  return {
    repos: [duplicateIdRepos()[1]],
    projects: [project],
    projectHostSetups: [setup],
    setupId: setup.id
  }
}

beforeEach(() => {
  hasCreatedStoreInCase = false
  resetRetirementCollisionKeyCacheForTests()
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-dup-repo-id-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('deleting one host copy of a repo id shared by two hosts', () => {
  it.each(['git', 'folder'] as const)(
    'removing the local %s row keeps the other host row and its metadata',
    async (kind) => {
      const store = await createStoreFromState({
        repos: duplicateIdRepos().map((repo) => ({ ...repo, kind }))
      })
      store.setWorktreeMeta(hostWorktreeTarget({ id: 'dup::/remote/dup', hostId: 'ssh:ssh-1' }), {
        displayName: 'SSH wt'
      })

      store.removeProjectForHost({ id: 'dup', executionHostId: 'local' })
      expect(store.getRepos().map((repo) => repo.path)).toEqual(['/remote/dup'])
      expect(Object.values(store.getAllWorktreeMeta()).map((meta) => meta.displayName)).toContain(
        'SSH wt'
      )
    }
  )

  it('moveProjectToGroup moves the addressed twin, not the first row with the id', async () => {
    const store = await createStoreWithDuplicateRepoId()
    const group = store.createProjectGroup({
      name: 'Remote',
      connectionId: 'ssh-1',
      createdFrom: 'manual'
    })
    const sshRow = store.getRepos().find((repo) => repo.connectionId === 'ssh-1')!

    const moved = store.moveProjectToGroup(sshRow, group.id, 3)

    expect(moved?.path).toBe('/remote/dup')
    const groupByPath = Object.fromEntries(
      store.getRepos().map((repo) => [repo.path, repo.projectGroupId ?? null])
    )
    expect(groupByPath).toEqual({ '/laptop/dup': null, '/remote/dup': group.id })
  })

  it('setResolvedRepoGitUsername writes only the probed host row', async () => {
    // Enrichment must update the probed location, including its host-scoped hydration cache.
    const store = await createStoreFromState({
      repos: [
        {
          id: 'dup',
          path: '/work/dup',
          displayName: 'Dup Local',
          badgeColor: '#000',
          addedAt: 1,
          executionHostId: 'local'
        } as Repo,
        {
          id: 'dup',
          path: '/work/dup',
          displayName: 'Dup Runtime',
          badgeColor: '#000',
          addedAt: 2,
          executionHostId: toRuntimeExecutionHostId('env-1')
        } as Repo
      ]
    })

    expect(
      store.setResolvedRepoGitUsername(
        { id: 'dup', executionHostId: toRuntimeExecutionHostId('env-1') },
        'runtime-user'
      )
    ).toBe(true)

    expect(store.getRepos().map((repo) => [repo.displayName, repo.gitUsername])).toEqual([
      ['Dup Local', ''],
      ['Dup Runtime', 'runtime-user']
    ])
  })

  it('a stale local setup for an id that only exists on ssh never deletes the ssh row', async () => {
    // Both load-time projection and host-scoped deletion must reject a stale setup’s sibling fallback.
    const { setupId, ...state } = staleLocalSetupState()
    const store = await createStoreFromState(state)

    const result = store.deleteProjectHostSetup({ setupId })

    expect(result?.repo).toBeUndefined()
    expect(store.getProjectHostSetups().map((setup) => setup.id)).not.toContain(setupId)
    expect(store.getRepos().map((repo) => repo.path)).toEqual(['/remote/dup'])
  })
})
