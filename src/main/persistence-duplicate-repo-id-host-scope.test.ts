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
import type { Repo } from '../shared/types'
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

async function createStoreWithDuplicateRepoId() {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), repos: duplicateIdRepos() }),
    'utf-8'
  )
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
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
})
