import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { Store } from '../../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore
} from '../../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  LEAF_ID,
  PTY_ID,
  REPO_ID,
  SIBLING_LEAF_ID,
  SIBLING_PTY_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  makeSession
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import { createHarness } from '../../__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { expectDesktopDropsPane } from '../../__fixtures__/main-layout-close-fixture'
import {
  retireTerminalSurfaceFromPersistence,
  sanitizeWorkspaceSessionTerminalRetirements
} from './mobile-session-terminal-persistence-retirement'
import { advanceTerminalTopologyRevision } from '../../../persistence/terminal-topology/terminal-topology-membership'

const splitLayout = {
  root: {
    type: 'split' as const,
    direction: 'horizontal' as const,
    first: { type: 'leaf' as const, leafId: LEAF_ID },
    second: { type: 'leaf' as const, leafId: SIBLING_LEAF_ID }
  },
  activeLeafId: LEAF_ID,
  expandedLeafId: null,
  ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SIBLING_LEAF_ID]: SIBLING_PTY_ID }
}

function splitSession(): WorkspaceSessionState {
  return { ...makeSession(), terminalLayoutsByTabId: { [TAB_ID]: splitLayout } }
}

function splitSessionAfterExitRetired(): WorkspaceSessionState {
  return retireTerminalSurfaceFromPersistence(splitSession(), {
    worktreeId: WORKTREE_ID,
    parentTabId: TAB_ID,
    leafId: LEAF_ID,
    ptyId: PTY_ID
  })
}

function withPinnedTab(session: WorkspaceSessionState): WorkspaceSessionState {
  return {
    ...session,
    tabsByWorktree: {
      [WORKTREE_ID]: (session.tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => ({
        ...tab,
        isPinned: true
      }))
    }
  }
}

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Real store with host-authoritative terminal membership, as after a repo exit. */
function createPersistedRuntime(session: WorkspaceSessionState) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-surface-close-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  store.addRepo({
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
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
      return createSqliteTestStore(Store, { dataFile }).getWorkspaceSession()
    }
  }
}

function rendererSaveWithout(
  session: WorkspaceSessionState,
  leafId?: string
): WorkspaceSessionState {
  const { terminalTopologyRevisionByRepoId: _hostPrivate, ...rendererView } = session
  if (!leafId) {
    return { ...rendererView, tabsByWorktree: { [WORKTREE_ID]: [] }, terminalLayoutsByTabId: {} }
  }
  return {
    ...rendererView,
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: SIBLING_LEAF_ID },
        activeLeafId: SIBLING_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SIBLING_LEAF_ID]: SIBLING_PTY_ID }
      }
    }
  }
}

describe('renderer close intents', () => {
  it('keeps a closed tab closed across a renderer save and a reload', async () => {
    const { store, runtime, reload } = createPersistedRuntime(makeSession())

    await runtime.closeTerminalSurfaceFromRenderer({
      worktreeId: WORKTREE_ID,
      target: { kind: 'tab', tabId: TAB_ID }
    })
    store.setWorkspaceSession(rendererSaveWithout(store.getWorkspaceSession()))

    expect((await reload()).tabsByWorktree[WORKTREE_ID]).toEqual([])
  })

  it('keeps a closed split pane closed across a renderer save and a reload', async () => {
    const { store, runtime, reload } = createPersistedRuntime(splitSession())

    await runtime.closeTerminalSurfaceFromRenderer({
      worktreeId: WORKTREE_ID,
      target: {
        kind: 'pane',
        tabId: TAB_ID,
        leafId: LEAF_ID
      }
    })
    store.setWorkspaceSession(rendererSaveWithout(store.getWorkspaceSession(), LEAF_ID))

    const reloaded = await reload()
    expect(reloaded.tabsByWorktree[WORKTREE_ID]).toEqual([expect.objectContaining({ id: TAB_ID })])
    expect(reloaded.terminalLayoutsByTabId[TAB_ID]?.root).toEqual({
      type: 'leaf',
      leafId: SIBLING_LEAF_ID
    })
    expect(reloaded.terminalPtyIncarnationsByPaneKey?.[makePaneKey(TAB_ID, LEAF_ID)]).toBe(
      undefined
    )
  })

  it.each([
    ['its exit already retired the pane', () => splitSessionAfterExitRetired()],
    ['the tab is pinned', () => withPinnedTab(splitSessionAfterExitRetired())],
    ['the tab has no saved layout', () => ({ ...makeSession(), terminalLayoutsByTabId: {} })]
  ])('never widens a pane close into a tab close when %s', async (_case, session) => {
    const { runtime, reload } = createPersistedRuntime(session())

    await runtime.closeTerminalSurfaceFromRenderer({
      worktreeId: WORKTREE_ID,
      target: {
        kind: 'pane',
        tabId: TAB_ID,
        leafId: LEAF_ID
      }
    })

    expect((await reload()).tabsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: TAB_ID })
    ])
  })
})

describe('CLI close of one pane in a split tab', () => {
  it.each([
    ['reports no exit', false],
    ['throws, as an unreachable SSH host does', new Error('ssh_host_unreachable')]
  ] as const)(
    'closes only that pane, never the live sibling, when its stop %s',
    async (_case, stopResult) => {
      const harness = createHarness({ publishMobileSurface: true, registerPtyBacked: true })
      harness.syncSplitFixtureGraph()
      harness.syncFixtureTabWithoutLeaf()
      harness.setVerifiedStopResult(stopResult)
      // Honor erroneous tab close so widening destroys the sibling and fails visibly.
      harness.setCloseTerminalTabAction(() => harness.retirePersistedTab())
      const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
        (candidate) => candidate.ptyId === PTY_ID
      )!

      const receipt = await harness.runtime.closeTerminal(terminal.handle)

      const saved = sanitizeWorkspaceSessionTerminalRetirements(
        { ...harness.getSession(), terminalLayoutsByTabId: { [TAB_ID]: splitLayout } },
        harness.getSession()
      )
      expect(saved.tabsByWorktree[WORKTREE_ID]).toEqual([expect.objectContaining({ id: TAB_ID })])
      expect(saved.terminalLayoutsByTabId[TAB_ID]?.root).toEqual({
        type: 'leaf',
        leafId: SIBLING_LEAF_ID
      })
      expectDesktopDropsPane(harness, TAB_ID, LEAF_ID)
      expect(harness.closeTerminalTab).not.toHaveBeenCalled()
      // Controller kill also records pending SSH stops; it must still run.
      expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
      expect(harness.kill).not.toHaveBeenCalledWith(SIBLING_PTY_ID)
      expect(receipt).toMatchObject({
        tabId: TAB_ID,
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable'
      })
    }
  )

  // L255: expected main-owned headless pane-close failure until its fix lands.

  it('keeps the sibling when the stop delivers the exit before the pane commit', async () => {
    const harness = createHarness()
    harness.syncSplitFixtureGraph()
    harness.setStopAndWaitAction((stoppingPtyId) => harness.runtime.onPtyExit(stoppingPtyId, 0))
    harness.setVerifiedStopResult(true)
    const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
      (candidate) => candidate.ptyId === PTY_ID
    )!

    await harness.runtime.closeTerminal(terminal.handle)

    const session = harness.getSession()
    expect(session.tabsByWorktree[WORKTREE_ID]).toEqual([expect.objectContaining({ id: TAB_ID })])
    expect(session.terminalLayoutsByTabId[TAB_ID]?.root).toEqual({
      type: 'leaf',
      leafId: SIBLING_LEAF_ID
    })
  })
})
