import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  testState,
  readPersistedState
} from '../../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getDefaultWorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupPolicyChange } from '../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import { WorkspaceCleanupRunner } from './workspace-cleanup-runner'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 14, 12))
  testState.dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cleanup-preview-')))
})
afterEach(async () => {
  await closeTestStores()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})
it('previews a project while saved Off, excludes other projects, and keeps policy state unchanged', async () => {
  const root = join(testState.dir, 'repo'),
    path = join(testState.dir, 'workspace')
  const old = Date.UTC(2026, 9, 5, 12)
  const git = (args: string[]) => {
    const result = runProcessSync({
      program: 'git',
      args,
      cwd: testState.dir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: new Date(old).toISOString(),
        GIT_COMMITTER_DATE: new Date(old).toISOString()
      }
    })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
  }
  git(['init', '-q', root])
  git(['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  writeFileSync(join(root, 'tracked.txt'), 'fixture\n')
  git(['-C', root, 'add', '.'])
  git([
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    'fixture'
  ])
  git(['-C', root, 'worktree', 'add', '-qb', 'topic', path])
  utimesSync(join(path, 'tracked.txt'), old / 1000, old / 1000)
  utimesSync(path, old / 1000, old / 1000)
  utimesSync(join(path, '.git'), old / 1000, old / 1000)
  const admin = readFileSync(join(path, '.git'), 'utf8').trim().replace('gitdir: ', '')
  for (const name of ['HEAD', 'ORIG_HEAD', 'COMMIT_EDITMSG']) {
    const file = join(admin, name)
    if (existsSync(file)) {
      utimesSync(file, old / 1000, old / 1000)
    }
  }
  const log = join(admin, 'logs', 'HEAD')
  writeFileSync(
    log,
    readFileSync(log, 'utf8').replace(
      /\s\d{1,11}\s([-+]\d{4})\t/g,
      ` ${Math.floor(old / 1000)} $1\t`
    )
  )
  const store = createStore()
  store.addRepo({
    id: 'project',
    path: root,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1,
    workspaceCleanupPolicy: { mode: 'off' }
  })
  store.addRepo({
    id: 'other',
    path: '/not-inspected',
    displayName: 'Other',
    badgeColor: 'gray',
    addedAt: 1,
    workspaceCleanupPolicy: { mode: 'custom', rules: getDefaultWorkspaceCleanupRules() }
  })
  const id = `project::${path}`
  store.setWorktreeMeta(hostWorktreeTarget({ id, hostId: 'local' }), {
    instanceId: 'fixture',
    createdAt: old,
    lastActivityAt: old
  })
  const runtime = {
    getWorktreePs: async () => ({
      truncated: false,
      worktrees: [
        {
          worktreeId: id,
          repoId: 'project',
          hostId: 'local',
          worktreeInstanceId: 'fixture',
          path,
          branch: 'topic',
          displayName: 'Fixture',
          isMainWorktree: false,
          isPinned: false,
          isActive: false,
          unverifiableTerminalCount: 0,
          agents: [],
          lastActivityAt: old,
          createdAt: old
        },
        {
          worktreeId: 'other::/not-inspected',
          repoId: 'other',
          hostId: 'local',
          path: '/not-inspected'
        }
      ]
    }),
    getExistingOrchestrationDb: () => null,
    getLocalProvider: () => ({ listProcesses: async () => [] }),
    listTerminals: async () => ({ terminals: [], truncated: false })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the host projection and terminal reads used by preview; Git, Store, policy resolution and evaluation are real.
  const hostRuntime = runtime as never
  const runner = new WorkspaceCleanupRunner({
    store,
    runtime: hostRuntime,
    historyDirectory: testState.dir
  })
  const expected = runner.readPolicy('project').state
  const preview = await runner.previewChange(
    {
      scope: 'project',
      repoId: 'project',
      policy: {
        mode: 'custom',
        rules: {
          ...getDefaultWorkspaceCleanupRules(),
          inactive: { enabled: true, afterDays: 30, action: 'delete' }
        }
      }
    },
    expected
  )
  expect(
    preview.current.rows.map((row) => ({ id: row.worktreeId, evaluation: row.evaluation }))
  ).toEqual([{ id, evaluation: { action: 'keep', cause: 'project-off' } }])
  expect(
    preview.next.rows.map((row) => ({ id: row.worktreeId, evaluation: row.evaluation }))
  ).toEqual([{ id, evaluation: { action: 'delete', reason: 'inactive' } }])
  expect(store.getRepo('project')!.workspaceCleanupPolicy).toEqual({ mode: 'off' })
  expect(store.getRepo('other')!.workspaceCleanupPolicy).toMatchObject({
    mode: 'custom',
    rules: { inactive: { enabled: false } }
  })
})

// The global owner refuses the same stale snapshot through the save path; the project scope is the divergent one.
it('rejects a proposal bound to an older project owner snapshot before previewing', async () => {
  const store = createStore()
  const repo = {
    id: 'project',
    path: testState.dir,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  }
  store.addRepo(repo)
  const active = {
    ...getDefaultWorkspaceCleanupRules(),
    inactive: { enabled: true, afterDays: 30, action: 'delete' as const }
  }
  store.updateRepo(repo, { workspaceCleanupPolicy: { mode: 'custom', rules: active } })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a rejected policy snapshot must never acquire workspace evidence.
  const runtime = { getWorktreePs: async () => ({ worktrees: [], truncated: false }) } as never
  const runner = new WorkspaceCleanupRunner({ store, runtime, historyDirectory: testState.dir })
  const expected = runner.readPolicy(repo.id).state
  const proposed = { ...active, merged: { enabled: true } }
  const change: WorkspaceCleanupPolicyChange = {
    scope: 'project',
    repoId: repo.id,
    policy: { mode: 'custom', rules: proposed }
  }
  const newer = { ...active, inactive: { ...active.inactive, enabled: false } }
  store.updateRepo(repo, { workspaceCleanupPolicy: { mode: 'custom', rules: newer } })
  await store.runDurableMutation(() => ({ value: true, persist: 'if-dirty' }))
  expect(() => runner.previewChange(change, expected)).toThrow('workspace_cleanup_policy_conflict')
  expect(
    readPersistedState().repos.find((row) => row.id === 'project')?.workspaceCleanupPolicy
  ).toMatchObject({
    mode: 'custom',
    rules: { merged: { enabled: false }, inactive: { enabled: false } }
  })
})
