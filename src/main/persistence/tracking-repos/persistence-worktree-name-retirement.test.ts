import {
  closeTestStores,
  createSqliteTestStore,
  createStore as createFreshStore,
  testState
} from '../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../../shared/constants'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { SshTarget } from '../../../shared/ssh-types'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { resetRetirementCollisionKeyCacheForTests } from '../../workspaces/removal/retirement/worktree-name-retirement'

let hasCreatedStoreInCase = false

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const REPO = 'repo-1'
const OTHER_REPO = 'repo-2'

const REMOTE_REPO = {
  id: REPO,
  path: '/remote/repos/a',
  displayName: 'a',
  badgeColor: '',
  addedAt: 0
}

function sshTarget(id: string, overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id,
    label: 'builder',
    host: 'builder.example.com',
    port: 22,
    username: 'dev',
    source: 'manual',
    ...overrides
  }
}

async function reloadStore() {
  vi.resetModules()
  const { Store } = await import('../loading-store/store')
  const { initDataPath } = await import('../loading-store/user-data-path')
  // Reinstall this test’s userData path after resetModules before initializing Store.
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

async function createStore(persisted: Record<string, unknown> = {}) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), ...persisted }),
    'utf-8'
  )
  if (!hasCreatedStoreInCase) {
    hasCreatedStoreInCase = true
    return createFreshStore()
  }
  return reloadStore()
}

beforeEach(() => {
  hasCreatedStoreInCase = false
  resetRetirementCollisionKeyCacheForTests()
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-worktree-name-retirement-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { force: true, recursive: true })
})

describe('worktree name retirement registry', () => {
  it('reassociates remote retirements after remove and re-add mints a new repo id', async () => {
    const oldRepo = {
      id: REPO,
      path: '/remote/repos/a',
      displayName: 'a',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    let store = await createStore()
    store.addRepo(oldRepo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('../../workspaces/removal/retirement/worktree-name-retirement')
    await retireGeneratedWorktreeName(store, oldRepo, store.getSettings(), 'nautilus')
    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(oldRepo) })
    store.flush()

    store = await reloadStore()
    const newRepo = { ...oldRepo, id: OTHER_REPO }
    store.addRepo(newRepo)

    await expect(
      getRetiredNameRegistryForRepo(store, newRepo, [newRepo], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('carries retirements across an in-place endpoint edit, which keeps the target id', async () => {
    // In-place config edits change endpoint-derived namespaces without triggering target re-adoption.
    const store = await createStore()
    store.addSshTarget(sshTarget('ssh-1', { configHost: 'builder', host: 'old.example.com' }))
    const repo = { ...REMOTE_REPO, connectionId: 'ssh-1' }
    store.addRepo(repo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('../../workspaces/removal/retirement/worktree-name-retirement')
    await retireGeneratedWorktreeName(store, repo, store.getSettings(), 'nautilus')

    store.updateSshTarget('ssh-1', { host: 'new.example.com' })

    // Remove the repo so the namespace mirror is the only remaining retirement source.
    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(repo) })
    const readded = { ...REMOTE_REPO, id: OTHER_REPO, connectionId: 'ssh-1' }
    store.addRepo(readded)
    await expect(
      getRetiredNameRegistryForRepo(store, readded, [readded], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('keeps a live sibling target its retirements when another row on the same endpoint rotates', async () => {
    const store = await createStore()
    // Distinct target rows may share an endpoint bucket; rotating one must preserve its sibling’s entries.
    store.addSshTarget(sshTarget('ssh-x', { configHost: 'builder', host: 'old.example.com' }))
    store.addSshTarget(sshTarget('ssh-y', { host: 'old.example.com' }))
    const sibling = { ...REMOTE_REPO, connectionId: 'ssh-y' }
    store.addRepo(sibling)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('../../workspaces/removal/retirement/worktree-name-retirement')
    await retireGeneratedWorktreeName(store, sibling, store.getSettings(), 'nautilus')

    // Re-adopt the same config alias at a new endpoint.
    store.removeSshTarget('ssh-x')
    store.addRemovedSshTargetTombstone({
      oldTargetId: 'ssh-x',
      configHost: 'builder',
      host: 'old.example.com',
      port: 22,
      username: 'dev',
      label: 'builder',
      removedAt: 0
    })
    store.addSshTarget(sshTarget('ssh-x-new', { configHost: 'builder', host: 'new.example.com' }))
    store.reassignSshTargetId('ssh-x', 'ssh-x-new')

    // The sibling stays at its original endpoint; remove its repo so only the namespace holds the retirement.
    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(sibling) })
    const readded = { ...REMOTE_REPO, id: OTHER_REPO, connectionId: 'ssh-y' }
    store.addRepo(readded)
    await expect(
      getRetiredNameRegistryForRepo(store, readded, [readded], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })
})
