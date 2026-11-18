import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as RepoScan from '../../runtime/workspaces/catalog/repo-worktree-resolution-scan'
import { runProcessSync } from '@orca/process-host'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getDefaultWorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { WorkspaceCleanupRunner } from './workspace-cleanup-runner'
import { _resetWorktreeCatalogOwnerForTests } from '../../workspaces/catalog/repo-worktree-catalog-owner'
const gate = vi.hoisted(() => ({
  sampled: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  hold: false
}))
vi.mock('electron', () => {
  const ipcMain = { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn() }
  return {
    ipcMain,
    BrowserWindow: { fromId: () => null },
    webContents: { fromId: () => null },
    app: { getPath: () => testState.dir, isPackaged: false },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('../../runtime/workspaces/catalog/repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: async () => null
}))
vi.mock('../../runtime/workspaces/catalog/repo-worktree-resolution-scan', async (load) => {
  const actual = await load<typeof RepoScan>()
  return {
    ...actual,
    scanLocalRepoWorktreesForResolution: async (
      ...args: Parameters<typeof actual.scanLocalRepoWorktreesForResolution>
    ) => {
      const scan = await actual.scanLocalRepoWorktreesForResolution(...args)
      if (gate.hold) {
        gate.hold = false
        gate.sampled.resolve()
        await gate.release.promise
      }
      return scan
    }
  }
})
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1))
  testState.dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cleanup-inventory-')))
  gate.sampled = Promise.withResolvers<void>()
  gate.release = Promise.withResolvers<void>()
  gate.hold = false
})
afterEach(async () => {
  gate.release.resolve()
  await closeTestStores()
  _resetWorktreeCatalogOwnerForTests()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})
it.each(['in-flight', 'cached'])(
  'discovers a real eligible checkout beyond a pre-click %s repo inventory',
  async (mode) => {
    const root = join(testState.dir, 'repo')
    const checkout = join(testState.dir, 'new')
    const git = (args: string[]) => {
      const result = runProcessSync({ program: 'git', args, cwd: testState.dir })
      if (result.code !== 0) {
        throw new Error(result.stderr)
      }
    }
    git(['init', '-q', root])
    git(['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(['-C', root, 'config', 'user.name', 'Fixture'])
    git(['-C', root, 'config', 'user.email', 'fixture@example.invalid'])
    writeFileSync(join(root, 'seed'), 'seed')
    git(['-C', root, 'add', '.'])
    git(['-C', root, 'commit', '-qm', 'seed'])
    const store = createStore()
    const repo = {
      id: 'repo',
      path: root,
      displayName: 'Inventory',
      badgeColor: 'gray',
      addedAt: 1
    }
    store.addRepo(repo)
    const id = `repo::${checkout}`
    store.setWorktreeMeta(hostWorktreeTarget({ id, hostId: 'local' }), {
      instanceId: 'new-instance',
      displayName: 'Newly discovered',
      createdAt: 1,
      lastActivityAt: 1
    })
    const runtime = new OrcaRuntimeService(store)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [],
      truncated: false,
      totalCount: 0
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal probing only calls listProcesses; inventory and repo-cache ownership use the real runtime.
    vi.spyOn(runtime, 'getLocalProvider').mockReturnValue({
      listProcesses: async () => []
    } as never)
    gate.hold = mode === 'in-flight'
    const older = runtime.getWorktreePs(100_000, true, false)
    await (mode === 'in-flight' ? gate.sampled.promise : older)
    git(['-C', root, 'worktree', 'add', '-qb', 'new-topic', checkout])
    const called = Promise.withResolvers<void>()
    const ps = runtime.getWorktreePs.bind(runtime)
    vi.spyOn(runtime, 'getWorktreePs').mockImplementation((...args) => {
      const result = ps(...args)
      if (args[5]) {
        called.resolve()
      }
      return result
    })
    const runner = new WorkspaceCleanupRunner({ store, runtime, historyDirectory: testState.dir })
    const change = {
      scope: 'global' as const,
      rules: { ...getDefaultWorkspaceCleanupRules(), unchanged: { enabled: true, afterDays: 1 } }
    }
    const confirmation = runner.previewChange(change, runner.readPolicy(null).state, true)
    await called.promise
    gate.release.resolve()
    const preview = await confirmation
    await older
    expect(
      preview.next.rows
        .filter((row) => row.evaluation.action === 'delete')
        .map((row) => row.worktreeId)
    ).toEqual([id])
    expect(preview.next.rows.find((row) => row.worktreeId === id)?.instanceId).toBe('new-instance')
  }
)
