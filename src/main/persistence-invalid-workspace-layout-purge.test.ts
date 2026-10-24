import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultWorkspaceSession } from '../shared/constants'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import type { DetectedWorktreeListResult } from '../shared/worktree/types'
import { collectLayoutEvents } from './runtime/workspace-layout-stream-events.test-fixture'
import {
  bumpLocalWorktreeScanGeneration,
  getLocalWorktreeCatalogVersion
} from './local-worktree-scan-generation'
import { dropWorkspacesTheListingInvalidates } from './persistence/restoring-sessions/invalid-workspace-layout-purge'
import { WorkspaceLayoutStream } from './runtime/workspace-layout-stream'
import { windowViewSaveForMain } from './persistence/window-save-view'

vi.mock('../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('./ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))

const REPO = 'repo-a'
const KEPT = `${REPO}::/work/kept`
const DELETED = `${REPO}::/work/deleted`
const SSH_REPO = 'ssh-repo'
const SSH_WORKTREE = `${SSH_REPO}::/home/me/app`
const SSH_HOST = 'ssh:target-1'
const RUNTIME_HOST = 'runtime:env-a'
const PAIRED_WORKTREE = 'paired-repo::/srv/app'

function sessionWith(...worktreeIds: string[]): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: Object.fromEntries(
      worktreeIds.map((worktreeId, index) => [
        worktreeId,
        [makeTerminalTab({ id: `tab-${index}`, ptyId: `pty-${index}`, worktreeId })]
      ])
    )
  }
}

function listing(
  worktreeIds: string[],
  overrides: Partial<DetectedWorktreeListResult> = {}
): DetectedWorktreeListResult {
  return {
    repoId: REPO,
    authoritative: true,
    source: 'git',
    catalogVersion: getLocalWorktreeCatalogVersion(REPO),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the purge reads only each row's id.
    worktrees: worktreeIds.map((id) => ({ id }) as DetectedWorktreeListResult['worktrees'][number]),
    ...overrides
  }
}

const storedKeys = (store: ReturnType<typeof createStore>, hostId?: string): string[] =>
  Object.keys(store.getWorkspaceSession(hostId).tabsByWorktree).sort()

describe('main drops the layout of workspaces the catalog no longer validates', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-invalid-layout-purge-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  describe('at load', () => {
    it('drops a stored workspace of a deregistered repo', () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [makeRepo({ id: REPO, path: '/work/kept' })],
        worktreeMeta: {},
        workspaceSession: sessionWith(KEPT, 'gone-repo::/work/gone')
      })

      expect(storedKeys(createStore())).toEqual([KEPT])
    })

    it('drops a stored workspace whose key names no registered repo, as the window does', () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [makeRepo({ id: REPO, path: '/work/kept' })],
        worktreeMeta: {},
        workspaceSession: sessionWith(KEPT, 'legacy-bare-key')
      })

      expect(storedKeys(createStore())).toEqual([KEPT])
    })

    it('keeps a degraded but registered repo, a disconnected SSH repo, folders and the floating workspace', () => {
      const folderKey = folderWorkspaceKey('folder-never-listed')
      writeDataFile({
        schemaVersion: 1,
        repos: [
          makeRepo({ id: REPO, path: '/work/kept' }),
          makeRepo({ id: SSH_REPO, path: '/home/me/app', connectionId: 'target-1' })
        ],
        worktreeMeta: {},
        workspaceSession: sessionWith(KEPT, DELETED, folderKey, FLOATING_TERMINAL_WORKTREE_ID),
        workspaceSessionsByHostId: { [SSH_HOST]: sessionWith(SSH_WORKTREE) }
      })

      const store = createStore()

      expect(storedKeys(store)).toEqual(
        [KEPT, DELETED, folderKey, FLOATING_TERMINAL_WORKTREE_ID].sort()
      )
      expect(storedKeys(store, SSH_HOST)).toEqual([SSH_WORKTREE])
    })

    it("keeps a paired host's workspaces, whose catalog lives on that host", () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: { [PAIRED_WORKTREE]: { hostId: RUNTIME_HOST, status: 'active' } },
        workspaceSession: sessionWith(PAIRED_WORKTREE),
        workspaceSessionsByHostId: { [RUNTIME_HOST]: sessionWith(PAIRED_WORKTREE, 'bare-paired') }
      })

      const store = createStore()

      expect(storedKeys(store)).toEqual([PAIRED_WORKTREE])
      expect(storedKeys(store, RUNTIME_HOST)).toEqual(['bare-paired', PAIRED_WORKTREE].sort())
    })
  })

  describe('when a listing changes the catalog', () => {
    function seededStore(): ReturnType<typeof createStore> {
      writeDataFile({
        schemaVersion: 1,
        repos: [
          makeRepo({ id: REPO, path: '/work/kept' }),
          makeRepo({ id: 'other-repo', path: '/x' })
        ],
        worktreeMeta: {},
        workspaceSession: sessionWith(KEPT, DELETED, 'other-repo::/x')
      })
      return createStore()
    }

    it("drops the workspace an authoritative scan no longer finds, and the window's frames lose it", async () => {
      const store = seededStore()
      const stream = new WorkspaceLayoutStream({
        store: () => store,
        homeHostId: () => 'local',
        liveTitle: () => null
      })
      const collector = collectLayoutEvents()
      const { events } = collector
      const { snapshot } = stream.subscribe(collector.listener)
      collector.seed(snapshot)
      expect(snapshot.map((entry) => entry.key)).toContain(DELETED)

      dropWorkspacesTheListingInvalidates(store, listing([KEPT]))
      await Promise.resolve()

      expect(storedKeys(store)).toEqual([KEPT, 'other-repo::/x'].sort())
      expect(events).toContainEqual(expect.objectContaining({ type: 'removed', key: DELETED }))
    })

    it('keeps every workspace after a scan that could not prove deletion', () => {
      const store = seededStore()

      dropWorkspacesTheListingInvalidates(
        store,
        listing([], { authoritative: false, source: 'metadata-fallback' })
      )
      dropWorkspacesTheListingInvalidates(
        store,
        listing([KEPT], { authoritative: false, source: 'metadata-fallback' })
      )
      dropWorkspacesTheListingInvalidates(store, null)
      dropWorkspacesTheListingInvalidates(store, { providerAbortStatus: 'timed-out' })

      expect(storedKeys(store)).toEqual([KEPT, DELETED, 'other-repo::/x'].sort())
    })

    it('keeps every workspace when a create or remove landed after the scan began', () => {
      const store = seededStore()
      const stale = listing([KEPT])
      bumpLocalWorktreeScanGeneration(REPO)

      dropWorkspacesTheListingInvalidates(store, stale)
      dropWorkspacesTheListingInvalidates(store, listing([KEPT], { catalogVersion: undefined }))

      expect(storedKeys(store)).toEqual([KEPT, DELETED, 'other-repo::/x'].sort())
    })

    it('keeps every workspace of a repo id another host also registers', () => {
      writeDataFile({
        schemaVersion: 1,
        repos: [
          makeRepo({ id: REPO, path: '/work/kept' }),
          makeRepo({ id: REPO, path: '/home/me/kept', connectionId: 'target-1' })
        ],
        worktreeMeta: {},
        workspaceSession: sessionWith(KEPT, DELETED)
      })
      const store = createStore()

      dropWorkspacesTheListingInvalidates(store, listing([KEPT]))

      expect(storedKeys(store)).toEqual([KEPT, DELETED].sort())
    })
  })

  it('a later window save that still names a dropped workspace does not bring it back', () => {
    const store = (() => {
      writeDataFile({
        schemaVersion: 1,
        repos: [makeRepo({ id: REPO, path: '/work/kept' })],
        worktreeMeta: {},
        workspaceSession: sessionWith(KEPT, DELETED)
      })
      return createStore()
    })()
    dropWorkspacesTheListingInvalidates(store, listing([KEPT]))

    store.setWorkspaceSession(
      windowViewSaveForMain(
        store.getWorkspaceSession('local'),
        sessionWith(KEPT, DELETED),
        'local'
      ),
      'local'
    )

    expect(storedKeys(store)).toEqual([KEPT])
  })
})
