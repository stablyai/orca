import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import { OrcaRuntimeWithPersistHeadlessSessionTabProps } from '../../runtime/orca-runtime-persist-headless-session-tab-props'
import type { Store } from '../loading-store/store'
import { closeLeafOrTab } from './terminal-topology-commit'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore
} from './terminal-topology-profile-fixture'
import { leafIds, WindowSession } from './terminal-topology-window-session-fixture'
import { checkWorkspaceLayoutRules } from '../../../shared/workspace-layout/workspace-layout-rules'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

// An older phone build sends a whole pane tree (`session.tabs.updatePaneLayout`) built before a
// split or close it has not seen yet. Main persists it only on a headless host (no window), so
// these run main's handler with no window against the real Store.

const WT = FIXTURE_GIT_WORKTREE_ID
const NEW_LEAF = '55555555-5555-4555-8555-555555555555'
const directories: string[] = []

type PaneLayoutHandler = Pick<
  OrcaRuntimeWithPersistHeadlessSessionTabProps,
  'updateMobileSessionPaneLayout'
>

/** Main's real `updateMobileSessionPaneLayout`, on a headless host whose session is `store`'s. */
function paneLayoutHandler(store: Store): PaneLayoutHandler {
  return Object.assign(Object.create(OrcaRuntimeWithPersistHeadlessSessionTabProps.prototype), {
    store,
    mobileSessionTabsByWorktree: new Map(),
    getValidatedExplicitWorktreeIdSelector: () => WT,
    getAvailableAuthoritativeWindow: () => null,
    getWorkspaceSessionForWorktree: () => store.getWorkspaceSession(),
    setWorkspaceSessionForWorktree: (_worktreeId: string, session: WorkspaceSessionState) =>
      store.setWorkspaceSession(session)
  })
}

function split(first: string, second: string): TerminalPaneLayoutNode {
  return {
    type: 'split',
    direction: 'vertical',
    ratio: 0.7,
    first: { type: 'leaf', leafId: first },
    second: { type: 'leaf', leafId: second }
  }
}

/** A tab whose panes the desktop window made and the renderer's spawns bound. */
async function openWithPanes(panes: readonly string[]): Promise<Store> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-stale-pane-tree-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(structuredClone(store.getWorkspaceSession()))
  window.addTab(WT, 'tab-a', panes[0]!)
  if (panes.length > 1) {
    window.setLayout('tab-a', split(panes[0]!, panes[1]!), {})
  }
  store.setWorkspaceSession(window.snapshot())
  for (const [index, leafId] of panes.entries()) {
    await expect(
      store.persistPtyBinding({ worktreeId: WT, tabId: 'tab-a', leafId, ptyId: `pty-${index + 1}` })
    ).resolves.toBe(true)
    window.bind('tab-a', leafId, `pty-${index + 1}`)
  }
  store.setWorkspaceSession(window.snapshot())
  return store
}

function violations(store: Store): string[] {
  return checkWorkspaceLayoutRules([
    { hostId: LOCAL_EXECUTION_HOST_ID, session: store.getWorkspaceSession() }
  ]).map((violation) => `${violation.rule}: ${violation.detail}`)
}

function panesOf(store: Store, tabId: string) {
  const layout = store.getWorkspaceSession().terminalLayoutsByTabId[tabId]
  return { leaves: leafIds(layout?.root), bindings: layout?.ptyIdsByLeafId ?? {} }
}

describe('an old client pane tree that predates a split or close', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps a pane another client split since the tree was built', async () => {
    const store = await openWithPanes([TEST_LEAF_1])
    // `terminal.split` from the CLI: a host-created pane bound against its source pane.
    await expect(
      store.persistPtyBinding({
        worktreeId: WT,
        tabId: 'tab-a',
        leafId: NEW_LEAF,
        ptyId: 'pty-new',
        hostAdmittedMembership: true,
        expectedSourceBinding: { tabId: 'tab-a', leafId: TEST_LEAF_1, ptyId: 'pty-1' }
      })
    ).resolves.toBe(true)

    await paneLayoutHandler(store).updateMobileSessionPaneLayout(`id:${WT}`, {
      tabId: 'tab-a',
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      expandedLeafId: null
    })
    try {
      expect(violations(store)).toEqual([])
      expect(panesOf(store, 'tab-a')).toEqual({
        leaves: [TEST_LEAF_1, NEW_LEAF],
        bindings: { [TEST_LEAF_1]: 'pty-1', [NEW_LEAF]: 'pty-new' }
      })
    } finally {
      await store.freezeWritesAsync()
    }
  })

  it('does not bring back a pane another client closed', async () => {
    const store = await openWithPanes([TEST_LEAF_1, TEST_LEAF_2])
    // A phone's pane close (`closeTerminalPane`): main commits it, not the layout owner.
    await expect(
      store.runDurableMutation(
        closeLeafOrTab({
          worktreeId: WT,
          target: { kind: 'pane', tabId: 'tab-a', leafId: TEST_LEAF_2 },
          options: { allowMissing: true },
          requestedSession: store.getWorkspaceSession(),
          ownerMatches: () => true,
          hostId: () => LOCAL_EXECUTION_HOST_ID,
          getSession: (hostId) => store.getWorkspaceSession(hostId),
          setSession: (session, hostId) => store.setWorkspaceSession(session, hostId),
          onClosed: () => {}
        })
      )
    ).resolves.toBeUndefined()

    await paneLayoutHandler(store).updateMobileSessionPaneLayout(`id:${WT}`, {
      tabId: 'tab-a',
      root: split(TEST_LEAF_1, TEST_LEAF_2),
      expandedLeafId: null
    })
    try {
      expect(violations(store)).toEqual([])
      expect(panesOf(store, 'tab-a')).toEqual({
        leaves: [TEST_LEAF_1],
        bindings: { [TEST_LEAF_1]: 'pty-1' }
      })
    } finally {
      await store.freezeWritesAsync()
    }
  })

  it('does not put a dragged-out pane back in its source tab', async () => {
    const store = await openWithPanes([TEST_LEAF_1, TEST_LEAF_2])
    await expect(
      store.moveTerminalLeafToNewTab({
        worktreeId: WT,
        sourceTabId: 'tab-a',
        targetTabId: 'tab-b',
        leafId: TEST_LEAF_2,
        ptyId: 'pty-2'
      })
    ).resolves.toEqual({ status: 'moved', ptyId: 'pty-2' })

    await paneLayoutHandler(store).updateMobileSessionPaneLayout(`id:${WT}`, {
      tabId: 'tab-a',
      root: split(TEST_LEAF_1, TEST_LEAF_2),
      expandedLeafId: null
    })
    try {
      expect(violations(store).filter((breach) => breach.startsWith('pane_'))).toEqual([])
      expect(panesOf(store, 'tab-a').leaves).toEqual([TEST_LEAF_1])
      expect(panesOf(store, 'tab-b').leaves).toEqual([TEST_LEAF_2])
    } finally {
      await store.freezeWritesAsync()
    }
  })

  // Known on main: with no topology revision for the repo, the membership rebase is skipped and
  // `persistHeadlessTerminalPaneLayout` takes the tree whole, dropping a live pane and its binding
  // (the tab row still names its PTY). Drop `fails` once fixed.
  it.fails('keeps a pane the tree omits when the repo never had a host topology change', async () => {
    const store = await openWithPanes([TEST_LEAF_1, TEST_LEAF_2])
    await paneLayoutHandler(store).updateMobileSessionPaneLayout(`id:${WT}`, {
      tabId: 'tab-a',
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      expandedLeafId: null
    })
    try {
      expect(violations(store)).toEqual([])
      expect(panesOf(store, 'tab-a').leaves).toEqual([TEST_LEAF_1, TEST_LEAF_2])
    } finally {
      await store.freezeWritesAsync()
    }
  })
})
