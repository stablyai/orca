import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { TerminalLayoutSnapshot, WorkspaceSessionState } from '../../shared/types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/workspace`
const TAB_ID = 'tab-remote'
const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE_PTY_ID = 'pty-source'
const SPLIT_PTY_ID = 'pty-split'

function sourceLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: SOURCE_LEAF_ID },
    activeLeafId: SOURCE_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [SOURCE_LEAF_ID]: SOURCE_PTY_ID }
  }
}

function persistedSession(includeSource = true): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: includeSource
      ? {
          [WORKTREE_ID]: [
            {
              id: TAB_ID,
              ptyId: SOURCE_PTY_ID,
              worktreeId: WORKTREE_ID,
              title: 'Remote terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      : {},
    terminalLayoutsByTabId: includeSource ? { [TAB_ID]: sourceLayout() } : {}
  }
}

function remoteSnapshot(): RuntimeMobileSessionTabsSnapshot {
  const layout = sourceLayout()
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'remote-viewer',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: `${TAB_ID}::${SOURCE_LEAF_ID}`,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group-1', activeTabId: TAB_ID, tabOrder: [TAB_ID] }],
    tabs: [
      {
        type: 'terminal',
        id: `${TAB_ID}::${SOURCE_LEAF_ID}`,
        parentTabId: TAB_ID,
        leafId: SOURCE_LEAF_ID,
        ptyId: SOURCE_PTY_ID,
        title: 'Remote terminal',
        parentLayout: layout,
        isActive: true
      }
    ]
  }
}

function createHarness(includeSource = true) {
  let session = persistedSession(includeSource)
  const repo = {
    id: REPO_ID,
    path: '/workspace',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    persistPtyBinding: () => true
  }
  const spawn = vi.fn(async () => ({ id: SPLIT_PTY_ID }))
  const kill = vi.fn(() => true)
  const revealTerminalSession = vi
    .fn()
    .mockRejectedValue(new Error(`Terminal tab ${TAB_ID} not found`))
  const runtime = new OrcaRuntimeService(store as never)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: WORKTREE_ID,
      path: '/workspace',
      connectionId: null,
      repo,
      folderWorkspace: null
    }))
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill,
    getForegroundProcess: async () => null
  })
  runtime.setNotifier({ revealTerminalSession } as never)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: includeSource ? [remoteSnapshot()] : []
  })
  runtime.registerPty(SOURCE_PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: SOURCE_LEAF_ID
  })
  const internals = runtime as unknown as {
    getTerminalHandleForPaneKey: (paneKey: string) => string | null
    issuePtyHandle: (pty: unknown) => string
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    ptysById: Map<string, unknown>
  }
  const handle =
    internals.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, SOURCE_LEAF_ID)) ??
    internals.issuePtyHandle(internals.ptysById.get(SOURCE_PTY_ID))
  return {
    runtime,
    handle,
    spawn,
    kill,
    revealTerminalSession,
    getSession: () => session,
    getSnapshot: () => internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)
  }
}

describe('remote runtime terminal split authority', () => {
  it('splits a persisted tab without consulting an unmounted host renderer', async () => {
    const harness = createHarness()

    const outcome = await harness.runtime
      .splitTerminal(harness.handle, { direction: 'vertical' })
      .then((split) => ({ ok: true as const, split }))
      .catch((error: unknown) => ({ ok: false as const, error }))

    expect.soft(outcome).toMatchObject({
      ok: true,
      split: { tabId: TAB_ID, handle: expect.stringMatching(/^term_/) }
    })
    expect.soft(harness.spawn).toHaveBeenCalledTimes(1)
    expect.soft(harness.kill).not.toHaveBeenCalled()
    expect.soft(harness.revealTerminalSession).not.toHaveBeenCalled()
    const persistedLayout = harness.getSession().terminalLayoutsByTabId[TAB_ID]
    expect(persistedLayout).toMatchObject({
      root: { type: 'split', direction: 'vertical' },
      ptyIdsByLeafId: {
        [SOURCE_LEAF_ID]: SOURCE_PTY_ID
      }
    })
    expect(Object.values(persistedLayout!.ptyIdsByLeafId!)).toContain(SPLIT_PTY_ID)
    const siblingSurfaces = harness
      .getSnapshot()!
      .tabs.filter(
        (tab): tab is Extract<typeof tab, { type: 'terminal' }> =>
          tab.type === 'terminal' && tab.parentTabId === TAB_ID
      )
    expect(siblingSurfaces).toHaveLength(2)
    expect(siblingSurfaces.every((tab) => tab.parentLayout?.root?.type === 'split')).toBe(true)
  })

  it('rejects an unowned split source before spawning a PTY', async () => {
    const harness = createHarness(false)

    const outcome = await harness.runtime
      .splitTerminal(harness.handle, { direction: 'vertical' })
      .then(() => 'resolved')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))

    expect.soft(outcome).toBe('terminal_split_source_not_found')
    expect.soft(harness.spawn).not.toHaveBeenCalled()
    expect.soft(harness.kill).not.toHaveBeenCalled()
    expect.soft(harness.revealTerminalSession).not.toHaveBeenCalled()
  })
})
