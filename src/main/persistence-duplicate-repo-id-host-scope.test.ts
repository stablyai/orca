/**
 * The same repo id may be registered on two execution hosts (see `removeProjectForHost`).
 * Every deletion that resolves a *row* must therefore delete only that row: `removeProject`
 * is id-only and would take the sibling host's registration with it. Since #11994 those
 * deletions fan out to every paired device, so a cross-host over-delete is no longer local.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Project, ProjectHostSetup, Repo } from '../shared/types'
import { getDefaultPersistedState } from '../shared/constants'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

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
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

function createStoreWithDuplicateRepoId() {
  return createStoreFromState({ repos: duplicateIdRepos() })
}

/** A persisted local setup pointing at a repo id that only exists on ssh:ssh-1. */
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
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-dup-repo-id-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('deleting one host copy of a repo id shared by two hosts', () => {
  it('keeps both rows resolvable after load', async () => {
    const store = await createStoreWithDuplicateRepoId()

    expect(store.getRepos().map((repo) => repo.path)).toEqual(['/laptop/dup', '/remote/dup'])
  })

  it('removeProjectForHost drops only the addressed host row', async () => {
    const store = await createStoreWithDuplicateRepoId()

    store.removeProjectForHost('dup', 'ssh:ssh-1')

    expect(store.getRepos().map((repo) => repo.path)).toEqual(['/laptop/dup'])
  })

  it('deleteProjectHostSetup drops only the row it reports, never the sibling host', async () => {
    // Repo-derived setups reuse the repo id, so a duplicated id yields two setups with the
    // same setup id and the lookup can only resolve one. Whichever it resolves, the other
    // host's registration must survive.
    const store = await createStoreWithDuplicateRepoId()

    const result = store.deleteProjectHostSetup({ setupId: 'dup' })

    expect(result?.repo?.path).toBeDefined()
    expect(store.getRepos().map((repo) => repo.path)).toEqual(
      duplicateIdRepos()
        .map((repo) => repo.path)
        .filter((path) => path !== result?.repo?.path)
    )
  })

  it('a stale local setup for an id that only exists on ssh never deletes the ssh row', async () => {
    // Two mechanisms must each hold this line: load-time projection drops the stale setup, and
    // deleteProjectHostSetup resolves the repo by (repoId, setup.hostId) with no sibling fallback.
    const { setupId, ...state } = staleLocalSetupState()
    const store = await createStoreFromState(state)

    const result = store.deleteProjectHostSetup({ setupId })

    expect(result?.repo).toBeUndefined()
    expect(store.getProjectHostSetups().map((setup) => setup.id)).not.toContain(setupId)
    expect(store.getRepos().map((repo) => repo.path)).toEqual(['/remote/dup'])
  })
})
