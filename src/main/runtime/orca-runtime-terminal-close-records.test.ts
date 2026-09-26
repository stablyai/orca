import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { MAX_CLOSED_TERMINAL_TAB_TOMBSTONES } from '../../shared/closed-terminal-tab-tombstones'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { Store } from '../persistence/loading-store/store'
import { OrcaRuntimeService } from './orca-runtime'
import {
  LEAF_ID,
  REPO_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  makeSession
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'

const SSH_REPO_ID = 'ssh-repo'
const SSH_HOST_ID = 'ssh:target-1'
const SSH_WORKTREE_ID = `${SSH_REPO_ID}::/srv/app`
const LATE_TAB_ID = '6f0a5c8e-2b1d-4c3e-9f7a-1d2e3f4a5b6c'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createPersistedRuntime(session: WorkspaceSessionState = makeSession()) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-close-records-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const store = new Store({ dataFile })
  store.addRepo({
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: SSH_REPO_ID,
    path: '/srv/app',
    displayName: 'Remote',
    badgeColor: 'gray',
    addedAt: 1,
    connectionId: 'target-1'
  })
  store.setWorkspaceSession(advanceTerminalTopologyRevision(session, WORKTREE_ID))
  store.flushOrThrow()
  return {
    store,
    runtime: new OrcaRuntimeService(store),
    reload: async () => {
      store.flush()
      store.freezeWrites()
      await store.waitForPendingWrite()
      return new Store({ dataFile })
    }
  }
}

/** A renderer save: membership as the renderer holds it, and no close records, which it never sends. */
function rendererSave(session: WorkspaceSessionState): WorkspaceSessionState {
  const {
    terminalTopologyRevisionByRepoId: _hostPrivate,
    closedTerminalTabTombstonesByTabId: _mainOwned,
    ...rendererView
  } = session
  return { ...rendererView, tabsByWorktree: { [WORKTREE_ID]: [] }, terminalLayoutsByTabId: {} }
}

describe('close records', () => {
  it.each(['user', 'cleanup'] as const)(
    'records a %s close in main and keeps it across a renderer save and a reload',
    async (reason) => {
      const { store, runtime, reload } = createPersistedRuntime()

      await runtime.closeTerminalSurfaceFromRenderer(
        WORKTREE_ID,
        { kind: 'tab', tabId: TAB_ID },
        reason
      )
      store.setWorkspaceSession(rendererSave(store.getWorkspaceSession()))

      const reloaded = (await reload()).getWorkspaceSession()
      expect(reloaded.tabsByWorktree[WORKTREE_ID]).toEqual([])
      expect(reloaded.closedTerminalTabTombstonesByTabId?.[TAB_ID]).toEqual({
        closedAt: expect.any(Number),
        worktreeId: WORKTREE_ID,
        reason
      })
    }
  )

  // The store keeps main's map only when a write omits it; main's own writes carry it and win.
  it("keeps main's own record writes across later store writes", async () => {
    const { store, runtime } = createPersistedRuntime()

    await runtime.closeTerminalSurfaceFromRenderer(WORKTREE_ID, { kind: 'tab', tabId: TAB_ID })
    await runtime.closeTerminalSurfaceFromRenderer(WORKTREE_ID, { kind: 'tab', tabId: LATE_TAB_ID })
    store.setWorkspaceSession(rendererSave(store.getWorkspaceSession()))

    expect(
      Object.keys(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId ?? {}).sort()
    ).toEqual([LATE_TAB_ID, TAB_ID].sort())
  })

  it('records nothing for a split pane close, which leaves its tab open', async () => {
    const { store, runtime } = createPersistedRuntime()

    await runtime.closeTerminalSurfaceFromRenderer(WORKTREE_ID, {
      kind: 'pane',
      tabId: 'unknown-tab',
      leafId: LEAF_ID
    })

    expect(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId).toBeUndefined()
  })

  // Why: only a resolved tab close records; a pane target never widens here, even on the last pane.
  it("records nothing for a pane close aimed at its tab's only pane", async () => {
    const { store, runtime } = createPersistedRuntime()

    await runtime.closeTerminalSurfaceFromRenderer(WORKTREE_ID, {
      kind: 'pane',
      tabId: TAB_ID,
      leafId: LEAF_ID
    })

    expect(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId).toBeUndefined()
    expect(store.getWorkspaceSession().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      TAB_ID
    ])
  })

  // The durable half of refusing a late graft: the close lands while the tab's spawn is in
  // flight, so main has never listed the tab, and the spawn commits only after a relaunch.
  it('refuses a closed tab whose spawn commits after a crash and reload', async () => {
    const { runtime, reload } = createPersistedRuntime()

    await runtime.closeTerminalSurfaceFromRenderer(WORKTREE_ID, { kind: 'tab', tabId: LATE_TAB_ID })
    const relaunched = await reload()

    expect(
      await relaunched.persistPtyBinding({
        worktreeId: WORKTREE_ID,
        tabId: LATE_TAB_ID,
        leafId: LEAF_ID,
        ptyId: 'late-pty',
        incarnationId: 'late-incarnation'
      })
    ).toBe(false)
    expect(
      relaunched.getWorkspaceSession().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)
    ).not.toContain(LATE_TAB_ID)
  })

  it('refuses the graft when the close was recorded in another host partition', async () => {
    const { store, runtime } = createPersistedRuntime()
    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), tabsByWorktree: { [SSH_WORKTREE_ID]: [] } },
      SSH_HOST_ID
    )

    await runtime.closeTerminalSurfaceFromRenderer(SSH_WORKTREE_ID, {
      kind: 'tab',
      tabId: LATE_TAB_ID
    })

    expect(
      store.getWorkspaceSession(SSH_HOST_ID).closedTerminalTabTombstonesByTabId?.[LATE_TAB_ID]
    ).toBeDefined()
    // A relay reattach binds into `local`, not the partition the close was recorded in.
    expect(
      await store.persistPtyBinding({
        worktreeId: SSH_WORKTREE_ID,
        tabId: LATE_TAB_ID,
        leafId: LEAF_ID,
        ptyId: 'ssh:target-1@@pty2:epoch:1',
        incarnationId: 'relay-incarnation'
      })
    ).toBe(false)
  })

  it('prunes each host partition alone, so local churn evicts no SSH record', async () => {
    const { store, runtime } = createPersistedRuntime()
    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), tabsByWorktree: { [SSH_WORKTREE_ID]: [] } },
      SSH_HOST_ID
    )
    await runtime.closeTerminalSurfaceFromRenderer(SSH_WORKTREE_ID, {
      kind: 'tab',
      tabId: 'ssh-tab'
    })

    for (let index = 0; index <= MAX_CLOSED_TERMINAL_TAB_TOMBSTONES; index += 1) {
      await runtime.closeTerminalSurfaceFromRenderer(WORKTREE_ID, {
        kind: 'tab',
        tabId: `local-${index}`
      })
    }

    expect(
      Object.keys(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId ?? {})
    ).toHaveLength(MAX_CLOSED_TERMINAL_TAB_TOMBSTONES)
    expect(
      store.getWorkspaceSession(SSH_HOST_ID).closedTerminalTabTombstonesByTabId?.['ssh-tab']
    ).toBeDefined()
  })
})
