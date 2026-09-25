import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { Store } from '../persistence/loading-store/store'
import { OrcaRuntimeService } from './orca-runtime'
import {
  LEAF_ID,
  PTY_ID,
  REPO_ID,
  SIBLING_LEAF_ID,
  SIBLING_PTY_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  createHarness,
  makeSession
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'

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

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A real store whose repo already has host-authoritative membership, as any repo with an exit does. */
function createPersistedRuntime(session: WorkspaceSessionState) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-surface-close-'))
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
  store.setWorkspaceSession(advanceTerminalTopologyRevision(session, WORKTREE_ID))
  store.flushOrThrow()
  return {
    store,
    runtime: new OrcaRuntimeService(store),
    reload: async () => {
      store.flush()
      store.freezeWrites()
      await store.waitForPendingWrite()
      return new Store({ dataFile }).getWorkspaceSession()
    }
  }
}

/** What a renderer save carries after its own close: membership without the closed surface. */
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

    runtime.closeTerminalSurfaceFromRenderer({ worktreeId: WORKTREE_ID, tabId: TAB_ID })
    store.setWorkspaceSession(rendererSaveWithout(store.getWorkspaceSession()))

    expect((await reload()).tabsByWorktree[WORKTREE_ID]).toEqual([])
  })

  it('keeps a closed split pane closed across a renderer save and a reload', async () => {
    const { store, runtime, reload } = createPersistedRuntime(splitSession())

    runtime.closeTerminalSurfaceFromRenderer({
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID
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
})

describe('CLI close of one pane in a split tab', () => {
  it('commits the pane removal without waiting for its process exit', async () => {
    const harness = createHarness()
    harness.syncSplitFixtureGraph()
    // A verified stop that never reports an exit: membership must not ride on one.
    harness.setVerifiedStopResult(true)
    const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
      (candidate) => candidate.ptyId === PTY_ID
    )!

    await expect(harness.runtime.closeTerminal(terminal.handle)).resolves.toMatchObject({
      tabId: TAB_ID,
      ptyKilled: true
    })

    const session = harness.getSession()
    expect(session.tabsByWorktree[WORKTREE_ID]).toEqual([expect.objectContaining({ id: TAB_ID })])
    expect(session.terminalLayoutsByTabId[TAB_ID]).toMatchObject({
      root: { type: 'leaf', leafId: SIBLING_LEAF_ID },
      ptyIdsByLeafId: { [SIBLING_LEAF_ID]: SIBLING_PTY_ID }
    })
    // No exit arrives to remove the pane, so the desktop renderer is told to drop that leaf.
    expect(harness.closeTerminal).toHaveBeenCalledExactlyOnceWith(TAB_ID, LEAF_ID)
    expect(harness.closeTerminalTab).not.toHaveBeenCalled()
  })
})

describe('mobile close of one pane in a split tab', () => {
  it('commits the pane removal alongside its kill', async () => {
    const harness = createHarness({ publishMobileSurface: true, registerPtyBacked: true })
    harness.syncSplitFixtureGraph()

    await expect(
      harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, `${TAB_ID}::${LEAF_ID}`, {
        reason: 'user'
      })
    ).resolves.toMatchObject({ closed: true })

    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
    expect(harness.getSession().terminalLayoutsByTabId[TAB_ID]).toMatchObject({
      root: { type: 'leaf', leafId: SIBLING_LEAF_ID }
    })
    expect(harness.closeTerminal).toHaveBeenCalledExactlyOnceWith(TAB_ID, LEAF_ID)
  })
})
