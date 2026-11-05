import {
  buildCanonicalRunWorkers,
  canonicalRunWorkerOptions
} from '../../../ipc/pty/canonical-pty-run-test-support'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createLiveProfileStateStore } from '../../../persistence/profile-state/profile-state-live-store-factory'
import type { Store } from '../../../persistence/loading-store/store'
import { captureRepositoryOwnerRemoval } from './canonical-owner-removal-scopes'
import { RuntimeRepositorySettingsController } from '../../repositories/runtime-repository-settings-controller'
import { commitCanonicalResumeRecordEdit } from '../../terminal/stop/canonical-resume-record-edit'
import {
  seedTestAgentSessionRecordStore,
  openTestAgentSessionRecordStore
} from '../../agent-session/records/agent-session-record-store-test-harness'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { installSurfaceNativeRuntimeOwner } from '../../../workspace-surfaces/surface-native-runtime-owner'
import { mutateTestJournalFixture } from '../../../native-chat/agent-session-journal/journal-drained-fixture-test-support'
import { finishRuntimeLocalWorktreeRemoval } from './runtime-registered-local-worktree-removal'
import type * as WorktreeRemoval from '../../../git/worktrees/removal/worktree-removal'

vi.mock('../../../git/worktrees/removal/worktree-removal', async (original) => ({
  ...(await original<typeof WorktreeRemoval>()),
  removeWorktree: vi.fn(async () => ({}))
}))

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const workspace = 'repo::/workspace'
const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
let bundleRoot: string
const roots: string[] = []
const stores: Store[] = []
beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-removal-workers-'))
  await buildCanonicalRunWorkers(bundleRoot)
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await Promise.all(stores.splice(0).map((store) => store.freezeWritesAsync()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))
async function open(root?: string) {
  if (!root) {
    root = mkdtempSync(join(tmpdir(), 'orca-owner-removal-'))
    roots.push(root)
  }
  const { store } = await createLiveProfileStateStore(
    {
      dataFile: join(root, 'orca-data.json'),
      databaseFile: join(root, 'profile-state.db'),
      profileId: 'removal'
    },
    canonicalRunWorkerOptions(bundleRoot)
  )
  stores.push(store)
  return { root, store }
}
function addRepo(store: Store, hostId: 'local' | 'ssh:remote' = 'local') {
  store.addRepo({
    id: 'repo',
    path: '/workspace',
    displayName: 'Removal',
    badgeColor: 'gray',
    addedAt: 1,
    executionHostId: hostId
  })
  return store
    .getRepos()
    .find(
      (repo) => repo.executionHostId === hostId || (hostId === 'local' && !repo.executionHostId)
    )!
}
async function create(store: Store, hostId: 'local' | 'ssh:remote' = 'local', tabId = 'tab') {
  await store.executeWorkspaceSurfaceCommand({ type: 'initialize', hostId })
  expect(
    await store.applyLayoutCommand({ type: 'createTerminalTab', workspace, tabId, leafId }, [
      hostId
    ])
  ).toMatchObject({ ok: true })
}

it('removes the original project owner after stop facts arrive, preserving its same-ID SSH sibling across reopen', async () => {
  const { root, store } = await open()
  const repo = addRepo(store)
  addRepo(store, 'ssh:remote')
  await create(store)
  await create(store, 'ssh:remote', 'remote-tab')
  const stale = structuredClone(store.getWorkspaceSession())
  const controller = new RuntimeRepositorySettingsController({
    getStore: () => store,
    resolveRepo: async () => repo,
    forgetTerminalTopology: () => {},
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {},
    notifyWorktreesChanged: () => {},
    stopProjectTerminals: async (_repo, options) => {
      if (!options.closeStructuredSessions) {
        await commitCanonicalResumeRecordEdit(store, 'local', (session) => ({
          ...session,
          sleepingAgentSessionsByPaneKey: {
            [`tab:${leafId}`]: {
              paneKey: `tab:${leafId}`,
              worktreeId: workspace,
              agent: 'codex',
              providerSession: { key: 'session_id', id: 'stopped-agent' },
              prompt: '',
              state: 'done',
              capturedAt: 1,
              updatedAt: 1,
              origin: 'live'
            }
          }
        }))
      }
    }
  })
  expect(await controller.remove(repo)).toEqual({ removed: true })
  store.setWorkspaceSession(stale)
  expect(store.getWorkspaceSession().tabsByWorktree[workspace] ?? []).toEqual([])
  expect(store.getWorkspaceSession('ssh:remote').tabsByWorktree[workspace]).toHaveLength(1)
  await store.freezeWritesAsync()
  const reopened = (await open(root)).store
  expect(reopened.getWorkspaceSession().tabsByWorktree[workspace] ?? []).toEqual([])
  expect(reopened.getWorkspaceSession('ssh:remote').tabsByWorktree[workspace]).toHaveLength(1)
})

it('refuses a new holder admitted after capture and never deletes its project or successor', async () => {
  const { store } = await open()
  const repo = addRepo(store)
  await create(store)
  const remove = captureRepositoryOwnerRemoval(store, repo)
  expect(
    await store.applyLayoutCommand(
      {
        type: 'createTerminalTab',
        workspace,
        tabId: 'added-during-removal',
        leafId: '9e624081-ef73-4fc2-8ce2-ef06ac8d95e6'
      },
      ['local']
    )
  ).toMatchObject({ ok: true })
  const finalize = vi.fn(() => store.removeProjectForHost(repo))
  await expect(remove(finalize)).rejects.toThrow('contents changed')
  expect(finalize).not.toHaveBeenCalled()
  expect(store.getRepos()).toHaveLength(1)
  expect(store.getWorkspaceSession().tabsByWorktree[workspace]).toHaveLength(2)
})

it('keeps mixed native and terminal ownership plus catalog on rejection, then removes both in their common lane', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-native-owner-removal-'))
  roots.push(root)
  const sessionId = 'owner-chat'
  await seedTestAgentSessionRecordStore(root, {
    records: [agentSessionRecordFixture({ sessionId, location: { workspaceId: workspace } })],
    sessionTabs: []
  })
  const { store } = await open(root)
  const repo = addRepo(store)
  await create(store)
  const journal = await openTestJournalHostDatabase(root)
  await installSurfaceNativeRuntimeOwner(journal, store, 'local')
  const records = await openTestAgentSessionRecordStore(root)
  await records.setSessionTabVisibility(sessionId, true, 'native-tab')
  const stale = structuredClone(store.getWorkspaceSession())
  const before = store.readWorkspaceSurfaces()
  await mutateTestJournalFixture(journal, (db) =>
    db.exec(
      "CREATE TRIGGER reject_owner_hide BEFORE DELETE ON agent_session_tabs BEGIN SELECT RAISE(ABORT, 'owner hide rejected'); END"
    )
  )
  const finalize = vi.fn(() => store.removeProjectForHost(repo))
  const remove = captureRepositoryOwnerRemoval(store, repo, async () => records)
  const gate = { finish: vi.fn(async (_removed: boolean) => {}) }
  const finish = () =>
    finishRuntimeLocalWorktreeRemoval(
      {
        store,
        repo,
        target: { id: workspace },
        removedPushTarget: undefined,
        localOptions: {},
        force: false,
        deleteBranch: false,
        closeWatchers: async () => {},
        preserveBranchHead: (result) => result ?? {},
        finishRemoval: () => remove(finalize)
      },
      {
        path: '/workspace',
        branch: 'refs/heads/topic',
        head: 'head',
        isBare: false,
        isMainWorktree: false
      },
      gate
    )
  await expect(finish()).rejects.toThrow('owner hide rejected')
  expect(gate.finish).toHaveBeenCalledExactlyOnceWith(true)
  expect(finalize).not.toHaveBeenCalled()
  expect(store.readWorkspaceSurfaces()).toEqual(before)
  expect(records.getSessionTabId(sessionId)).toBe('native-tab')
  expect(store.getRepos()).toHaveLength(1)
  await mutateTestJournalFixture(journal, (db) => db.exec('DROP TRIGGER reject_owner_hide'))
  await finish()
  expect(finalize).toHaveBeenCalledTimes(1)
  expect(records.getSessionTabId(sessionId)).toBeNull()
  expect(records.getRecord(sessionId)).not.toBeNull()
  store.setWorkspaceSession(stale)
  await store.freezeWritesAsync()
  const reopened = (await open(root)).store
  expect(reopened.getRepos()).toEqual([])
  expect(reopened.getWorkspaceSession().tabsByWorktree[workspace] ?? []).toEqual([])
  expect(reopened.readWorkspaceSurfaces().some((surface) => surface.content !== null)).toBe(false)
})
