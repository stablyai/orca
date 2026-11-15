import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/tmp/worktree-a`
const SPLIT_TAB = 'tab-split'
const SINGLE_TAB = 'tab-single'
const LEFT = '11111111-1111-4111-8111-000000000001'
const RIGHT = '11111111-1111-4111-8111-000000000002'
const SINGLE = '11111111-1111-4111-8111-000000000003'

function windowShowingRightPane(): {
  runtime: OrcaRuntimeService
  write: (patch: Partial<WorkspaceSessionState>) => void
} {
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    activeRepoId: REPO_ID,
    activeWorktreeId: WORKTREE_ID,
    activeTabId: SPLIT_TAB,
    activeTabIdByWorktree: { [WORKTREE_ID]: SPLIT_TAB },
    activeTabTypeByWorktree: { [WORKTREE_ID]: 'terminal' },
    terminalLayoutsByTabId: {
      [SPLIT_TAB]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEFT },
          second: { type: 'leaf', leafId: RIGHT }
        },
        activeLeafId: RIGHT,
        expandedLeafId: null
      },
      [SINGLE_TAB]: {
        root: { type: 'leaf', leafId: SINGLE },
        activeLeafId: SINGLE,
        expandedLeafId: null
      }
    }
  }
  const writeListeners = new Set<(hostId: string | null) => void>()
  const store = {
    getRepo: () => store.getRepos()[0],
    getRepos: () => [
      { id: REPO_ID, path: '/tmp/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
    ],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces', nestWorkspaces: false }),
    getWorkspaceSession: () => session,
    onWorkspaceSessionWritten: (listener: (hostId: string | null) => void) => {
      writeListeners.add(listener)
      return () => {
        writeListeners.delete(listener)
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing and focus read only the store members built above.
  const runtime = new OrcaRuntimeService(store as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: SPLIT_TAB,
        worktreeId: WORKTREE_ID,
        title: 'split',
        activeLeafId: RIGHT,
        layout: null
      },
      {
        tabId: SINGLE_TAB,
        worktreeId: WORKTREE_ID,
        title: 'single',
        activeLeafId: SINGLE,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: SPLIT_TAB,
        worktreeId: WORKTREE_ID,
        leafId: LEFT,
        paneRuntimeId: 1,
        ptyId: 'pty-left'
      },
      {
        tabId: SPLIT_TAB,
        worktreeId: WORKTREE_ID,
        leafId: RIGHT,
        paneRuntimeId: 2,
        ptyId: 'pty-right'
      },
      {
        tabId: SINGLE_TAB,
        worktreeId: WORKTREE_ID,
        leafId: SINGLE,
        paneRuntimeId: 3,
        ptyId: 'pty-single'
      }
    ]
  })
  const write = (patch: Partial<WorkspaceSessionState>): void => {
    session = { ...session, ...patch }
    for (const listener of writeListeners) {
      listener(null)
    }
  }
  return { runtime, write }
}

async function focusedByLeaf(runtime: OrcaRuntimeService): Promise<Record<string, unknown>> {
  const { terminals } = await runtime.listTerminals(undefined, 50, { includeVisualLayouts: false })
  return Object.fromEntries(terminals.map((terminal) => [terminal.leafId, terminal.focused]))
}

async function handleByLeaf(runtime: OrcaRuntimeService): Promise<Record<string, string>> {
  const { terminals } = await runtime.listTerminals(undefined, 50, { includeVisualLayouts: false })
  return Object.fromEntries(terminals.map((terminal) => [terminal.leafId, terminal.handle]))
}

// No fake clock: a watch that waited for its deadline instead of the push would time the test out.
const WATCH_DEADLINE_MS = 60_000

describe('focused terminal', () => {
  it('lists only the active pane of the tab the window shows as focused', async () => {
    const { runtime } = windowShowingRightPane()

    expect(await focusedByLeaf(runtime)).toEqual({ [LEFT]: false, [RIGHT]: true, [SINGLE]: false })
  })

  it('lists no terminal as focused while the window shows an editor', async () => {
    const { runtime, write } = windowShowingRightPane()
    write({ activeTabTypeByWorktree: { [WORKTREE_ID]: 'editor' } })

    expect(await focusedByLeaf(runtime)).toEqual({ [LEFT]: false, [RIGHT]: false, [SINGLE]: false })
  })

  it('answers a focus watch when the window focuses another tab', async () => {
    const { runtime, write } = windowShowingRightPane()
    const handles = await handleByLeaf(runtime)
    const change = runtime.focusedTerminal.waitForChange(handles[RIGHT]!, {
      timeoutMs: WATCH_DEADLINE_MS
    })

    write({ activeTabId: SINGLE_TAB, activeTabIdByWorktree: { [WORKTREE_ID]: SINGLE_TAB } })

    await expect(change).resolves.toEqual({ handle: handles[SINGLE] })
  })

  it('answers a focus watch with no terminal when the window goes away', async () => {
    const { runtime } = windowShowingRightPane()
    const handles = await handleByLeaf(runtime)
    const change = runtime.focusedTerminal.waitForChange(handles[RIGHT]!, {
      timeoutMs: WATCH_DEADLINE_MS
    })

    runtime.markGraphUnavailable(1)

    await expect(change).resolves.toEqual({ handle: null })
  })
})
