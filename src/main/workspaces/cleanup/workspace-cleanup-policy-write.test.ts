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
import {
  getDefaultWorkspaceCleanupRules,
  resolveWorkspaceCleanupPolicy
} from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { settleWorkspaceCleanupPolicyWrite } from './workspace-cleanup-policy-write'
import { evaluateWorkspaceCleanup } from '../../../shared/workspace-cleanup/workspace-cleanup-evaluation'

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

it('rejects a stale two-client rule-off replacement at the owner mutation and can retry the intent', async () => {
  const { store, repo, rules, guard } = fixture()
  const expected = guard(repo.id)
  let arrived!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const controller = new RuntimeRepositorySettingsController({
    getStore: () => store,
    resolveRepo: async () => {
      arrived()
      await barrier
      return store.getRepo(repo.id)!
    },
    forgetTerminalTopology: () => {},
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {},
    notifyWorktreesChanged: () => {}
  })
  const pending = controller.update(repo.id, {
    workspaceCleanupPolicy: { mode: 'custom', rules: { ...rules, merged: { enabled: false } } },
    workspaceCleanupGuard: expected
  })
  const rejection = expect(pending).rejects.toThrow('workspace_cleanup_policy_conflict')
  await entered
  store.updateRepo(repo, {
    workspaceCleanupPolicy: {
      mode: 'custom',
      rules: { ...rules, inactive: { ...rules.inactive, enabled: false } }
    }
  })
  await store.runDurableMutation(() => ({ value: true, persist: 'if-dirty' }))
  release()
  await rejection
  const saved = store.getRepo(repo.id)!.workspaceCleanupPolicy
  expect(saved).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: true }, inactive: { enabled: false } }
  })
  expect(
    readPersistedState().repos.find((row) => row.id === repo.id)?.workspaceCleanupPolicy
  ).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: true }, inactive: { enabled: false } }
  })
  expect(expected.expected.projects[0].policy).toMatchObject({
    mode: 'custom',
    rules: { inactive: { enabled: true } }
  })
  const now = Date.UTC(2026, 10, 14)
  expect(
    evaluateWorkspaceCleanup(
      {
        reasons: [],
        blockers: [],
        lastActivityAt: now - 40 * 86400000,
        git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: now }
      },
      resolveWorkspaceCleanupPolicy(store.getSettings(), store.getRepo(repo.id)),
      now
    )
  ).toEqual({ action: 'keep', cause: 'no-rule-matched' })
  const latest = store.getRepo(repo.id)!.workspaceCleanupPolicy
  if (latest?.mode !== 'custom') {
    throw new Error('Expected custom fixture')
  }
  await controller.update(repo.id, {
    workspaceCleanupPolicy: {
      mode: 'custom',
      rules: { ...latest.rules, merged: { enabled: false } }
    },
    workspaceCleanupGuard: guard(repo.id)
  })
  expect(store.getRepo(repo.id)!.workspaceCleanupPolicy).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false }, inactive: { enabled: false } }
  })
})

it('checks the expected policy before clearing a project override', () => {
  const { store, repo, rules, guard } = fixture()
  const stale = guard(repo.id)
  store.updateRepo(repo, {
    workspaceCleanupPolicy: {
      mode: 'custom',
      rules: { ...rules, inactive: { ...rules.inactive, enabled: false } }
    }
  })
  expect(() =>
    store.updateRepo(repo, { workspaceCleanupPolicy: null, workspaceCleanupGuard: stale })
  ).toThrow('workspace_cleanup_policy_conflict')
  expect(store.getRepo(repo.id)!.workspaceCleanupPolicy).toMatchObject({
    mode: 'custom',
    rules: { inactive: { enabled: false } }
  })
})

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

it('fences a delayed write whose reply was lost before the owner received it', () => {
  const { store, repo, guard } = fixture()
  const delayed = guard(repo.id)
  expect(settleWorkspaceCleanupPolicyWrite(delayed.id, delayed.expiresAt)).toBe('cancelled')
  expect(() =>
    store.updateRepo(repo, { workspaceCleanupPolicy: null, workspaceCleanupGuard: delayed })
  ).toThrow('workspace_cleanup_policy_conflict')
  expect(store.getRepo(repo.id)!.workspaceCleanupPolicy?.mode).toBe('custom')
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
