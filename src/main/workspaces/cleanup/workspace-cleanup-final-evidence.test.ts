import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getDefaultWorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { WorkspaceLifecycleQueue } from '../../runtime/workspaces/lifecycle/workspace-lifecycle-queue'
import { WorkspaceCleanupRunner } from './workspace-cleanup-runner'
import { collectWorkspaceCleanupWorkspaces } from './workspace-cleanup-run-evidence'
import { removeWorkspaceForCleanup } from './workspace-cleanup-removal-step'
import * as status from '../../git/source-control/status/status-read'
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
const old = Date.UTC(2026, 9, 1)
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1))
  testState.dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cleanup-final-')))
})
afterEach(async () => {
  await closeTestStores()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})
function fixture(withQueue = true) {
  const root = join(testState.dir, 'repo'),
    path = join(testState.dir, 'work')
  const git = (args: string[]) => {
    const r = runProcessSync({
      program: 'git',
      args,
      cwd: testState.dir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: new Date(old).toISOString(),
        GIT_COMMITTER_DATE: new Date(old).toISOString()
      }
    })
    if (r.code !== 0) {
      throw new Error(r.stderr)
    }
    return r.stdout.trim()
  }
  git(['init', '-q', root])
  git(['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['-C', root, 'config', 'user.name', 'Fixture'])
  git(['-C', root, 'config', 'user.email', 'fixture@example.invalid'])
  writeFileSync(join(root, 'tracked'), 'seed')
  git(['-C', root, 'add', '.'])
  git(['-C', root, 'commit', '-qm', 'seed'])
  git(['-C', root, 'worktree', 'add', '-qb', 'topic', path])
  const store = createStore()
  const rules = { ...getDefaultWorkspaceCleanupRules(), unchanged: { enabled: true, afterDays: 1 } }
  store.updateSettings({ workspaceCleanupPolicy: rules })
  const repo = { id: 'good', path: root, displayName: 'Good', badgeColor: 'gray', addedAt: 1 }
  store.addRepo(repo)
  const id = `good::${path}`
  store.setWorktreeMeta(hostWorktreeTarget({ id, hostId: 'local' }), {
    instanceId: 'a',
    createdAt: old,
    lastActivityAt: old
  })
  const summary = {
    worktreeId: id,
    worktreeInstanceId: 'a',
    repoId: 'good',
    hostId: 'local',
    path,
    branch: 'topic',
    displayName: 'Good',
    isMainWorktree: false,
    isPinned: false,
    isActive: false,
    unverifiableTerminalCount: 0,
    agents: [],
    createdAt: old,
    lastActivityAt: old
  }
  const removed: string[] = []
  const runtime = {
    workspaceLifecycle: withQueue ? new WorkspaceLifecycleQueue() : null,
    requireStore: () => store,
    getWorktreePs: async () => ({ truncated: false, worktrees: [summary] }),
    getExistingOrchestrationDb: () => null,
    getLocalProvider: () => ({ listProcesses: async () => [] }),
    listTerminals: async () => ({ terminals: [], truncated: false }),
    listRepos: () => store.getRepos(),
    onClientEvent: () => () => {},
    notifyWorkspaceCleanupRunFinished: () => {},
    showManagedWorktree: async () => ({ id, repoId: 'good' }),
    removeManagedWorktree: async () => {
      removed.push(id)
      return {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: external inventory, terminals and deletion are fixtures; collector, Git, Store, runner and lifecycle queue are real.
  const host = runtime as never
  return { root, path, git, store, rules, repo, id, summary, runtime, host, removed }
}
it('runs healthy projects despite a broken project listing while consent previews fail closed', async () => {
  const f = fixture()
  f.store.addRepo({
    id: 'bad',
    path: join(testState.dir, 'missing'),
    displayName: 'Broken',
    badgeColor: 'gray',
    addedAt: 1
  })
  f.runtime.getWorktreePs = async () => ({
    truncated: false,
    worktrees: [
      f.summary,
      { ...f.summary, repoId: 'bad', worktreeId: 'bad::/missing/work', path: '/missing/work' }
    ]
  })
  const runner = new WorkspaceCleanupRunner({
    store: f.store,
    runtime: f.host,
    historyDirectory: testState.dir
  })
  await expect(
    runner.previewChange({ scope: 'global', rules: f.rules }, runner.readPolicy(null).state)
    // The consent preview names the broken project's failure instead of showing a partial list.
  ).rejects.toThrow('Repository folder was not found.')
  expect(f.removed).toEqual([])
  runner.start()
  try {
    const run = await runner.runNow('run-now')
    expect(f.removed).toEqual([f.id])
    expect(run.rows.find((row) => row.repoId === 'bad')).toMatchObject({ outcome: 'kept' })
    expect(run.rows.find((row) => row.repoId === 'good')).toMatchObject({ outcome: 'removed' })
  } finally {
    runner.stop()
  }
})
it('keeps a real unpushed commit made after status in the final removal recheck', async () => {
  const f = fixture()
  const [workspace] = await collectWorkspaceCleanupWorkspaces({
    store: f.store,
    runtime: f.host,
    globalRules: f.rules,
    now: Date.now()
  })
  const original = status.getStatus
  vi.spyOn(status, 'getStatus').mockImplementationOnce(async (...args) => {
    const sampled = await original(...args)
    writeFileSync(join(f.path, 'new-work'), 'unpublished work')
    f.git(['-C', f.path, 'add', '.'])
    f.git(['-C', f.path, 'commit', '-qm', 'backdated unpushed work'])
    return sampled
  })
  const outcome = await removeWorkspaceForCleanup({
    store: f.store,
    runtime: f.host,
    workspace,
    globalRules: () => f.rules,
    now: Date.now
  })
  expect(outcome).toMatchObject({ outcome: 'kept', keptOnRecheck: true })
  expect(f.removed).toEqual([])
  expect(existsSync(join(f.path, 'new-work'))).toBe(true)
  expect(f.git(['-C', f.path, 'rev-list', '--count', 'main..HEAD'])).toBe('1')
})
