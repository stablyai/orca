import { BrowserWindow } from 'electron'
import { registerRepoUpdateHandler } from '../../ipc/repos/repo-update-handler'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState
} from '../../persistence/persistence-test-harness'
import { RuntimeRepositorySettingsController } from '../../runtime/repositories/runtime-repository-settings-controller'
import { captureWorkspaceCleanupPolicyState } from '../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import { getDefaultWorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import {
  settleWorkspaceCleanupPolicyWrite,
  reserveWorkspaceCleanupPolicyWrite,
  recoverWorkspaceCleanupPolicyWrites
} from './workspace-cleanup-policy-write'
import { readWorkspaceCleanupPolicy } from './workspace-cleanup-policy-preview'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))
vi.mock('../../ipc/repos/repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(name, handler)
  },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 14, 12))
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-cleanup-policy-write-'))
})
afterEach(async () => {
  await closeTestStores()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})
function fixture() {
  const store = createStore()
  const repo = {
    path: testState.dir,
    displayName: 'Fixture',
    badgeColor: '#000',
    addedAt: 1,
    id: 'cleanup-fixture'
  }
  store.addRepo(repo)
  const rules = {
    ...getDefaultWorkspaceCleanupRules(),
    merged: { enabled: true },
    inactive: { enabled: true, afterDays: 30, action: 'delete' as const }
  }
  store.updateRepo(repo, { workspaceCleanupPolicy: { mode: 'custom', rules } })
  const guard = (repoId: string | null) => ({
    id: crypto.randomUUID(),
    expiresAt: Date.UTC(2026, 10, 14, 12, 1),
    expected: captureWorkspaceCleanupPolicyState(store.getSettings(), store.getRepos(), repoId)
  })
  return { store, repo, rules, guard }
}

it('guards global writes against concurrent project-policy changes', () => {
  const { store, repo, guard } = fixture()
  const stale = guard(null)
  store.updateRepo(repo, { workspaceCleanupPolicy: { mode: 'off' } })
  expect(() =>
    store.updateSettings({
      workspaceCleanupPolicy: { ...getDefaultWorkspaceCleanupRules(), merged: { enabled: true } },
      workspaceCleanupGuard: stale
    })
  ).toThrow('workspace_cleanup_policy_conflict')
  expect(store.getSettings().workspaceCleanupPolicy?.merged.enabled).toBe(false)
})

it('preserves the guard through local IPC and rejects a stale null clear before any mutation', async () => {
  const { store, repo, guard } = fixture()
  registerRepoUpdateHandler(new BrowserWindow(), store)
  const handler = handlers.get('repos:update')!
  const expected = guard(repo.id)
  store.updateRepo(repo, { workspaceCleanupPolicy: { mode: 'off' } })
  await expect(
    handler(undefined, {
      repoId: repo.id,
      hostId: 'local',
      updates: { workspaceCleanupPolicy: null, workspaceCleanupGuard: expected }
    })
  ).rejects.toThrow('workspace_cleanup_policy_conflict')
  expect(store.getRepo(repo.id)!.workspaceCleanupPolicy).toEqual({ mode: 'off' })
  await handler(undefined, {
    repoId: repo.id,
    hostId: 'local',
    updates: { workspaceCleanupPolicy: null, workspaceCleanupGuard: guard(repo.id) }
  })
  expect(store.getRepo(repo.id)!.workspaceCleanupPolicy).toBeUndefined()
})

it('fences a reserved write whose resolver outlives its original client', async () => {
  const { store, repo, guard } = fixture()
  const expected = { ...guard(repo.id), requireReservation: true as const }
  reserveWorkspaceCleanupPolicyWrite(store, expected)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new RuntimeRepositorySettingsController({
    getStore: () => store,
    resolveRepo: async () => {
      entered.resolve()
      await release.promise
      return store.getRepo(repo.id)!
    },
    forgetTerminalTopology: () => {},
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {},
    notifyWorktreesChanged: () => {}
  })
  const pending = controller.update(repo.id, {
    workspaceCleanupPolicy: null,
    workspaceCleanupGuard: expected
  })
  const rejection = expect(pending).rejects.toThrow('workspace_cleanup_policy_conflict')
  await entered.promise
  expect(readWorkspaceCleanupPolicy(store, repo.id).pendingWrites).toBe(true)
  settleWorkspaceCleanupPolicyWrite(expected.id, expected.expiresAt)
  expect(readWorkspaceCleanupPolicy(store, repo.id).pendingWrites).toBe(false)
  release.resolve()
  await rejection
  await store.runDurableMutation(() => ({ value: true, persist: 'if-dirty' }))
  expect(
    readPersistedState().repos.find((row) => row.id === repo.id)?.workspaceCleanupPolicy
  ).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: true }, inactive: { enabled: true } }
  })
})

it('preserves another live project writer while a second client opens settings', async () => {
  const { store, repo, guard } = fixture()
  const expected = { ...guard(repo.id), requireReservation: true as const }
  reserveWorkspaceCleanupPolicyWrite(store, expected)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new RuntimeRepositorySettingsController({
    getStore: () => store,
    resolveRepo: async () => {
      entered.resolve()
      await release.promise
      return store.getRepo(repo.id)!
    },
    forgetTerminalTopology: () => {},
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {},
    notifyWorktreesChanged: () => {}
  })
  const pending = controller.update(repo.id, {
    workspaceCleanupPolicy: null,
    workspaceCleanupGuard: expected
  })
  await entered.promise
  expect(recoverWorkspaceCleanupPolicyWrites(store)).toBe(true)
  expect(readWorkspaceCleanupPolicy(store, repo.id).pendingWrites).toBe(true)
  release.resolve()
  await pending
  await store.runDurableMutation(() => ({ value: true, persist: 'if-dirty' }))
  expect(
    readPersistedState().repos.find((row) => row.id === repo.id)?.workspaceCleanupPolicy
  ).toBeUndefined()
})

it('acknowledges a guarded project policy only once a restart would load it', async () => {
  const { store, repo, guard } = fixture()
  await store.runDurableMutation(() => ({ value: true, persist: 'if-dirty' }))
  registerRepoUpdateHandler(new BrowserWindow(), store)
  const handler = handlers.get('repos:update')!
  await handler(undefined, {
    repoId: repo.id,
    hostId: 'local',
    updates: { workspaceCleanupPolicy: { mode: 'off' }, workspaceCleanupGuard: guard(repo.id) }
  })
  // No flush here: the reply itself waited for the deferred save.
  expect(
    readPersistedState().repos.find((row) => row.id === repo.id)?.workspaceCleanupPolicy
  ).toEqual({ mode: 'off' })
})
