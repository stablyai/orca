import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { PublishedPane } from '../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutEvent } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo::/worktree'
const REPO = { id: 'repo', path: '/worktree', displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-1'

function session(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: PTY_ID,
          worktreeId: WORKTREE_ID,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: PTY_ID }
      }
    }
  }
}

function runtimeWithPane() {
  const sessions = new Map([[LOCAL_EXECUTION_HOST_ID, session()]])
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the layout stream and PTY title paths read only repos and the workspace session.
    {
      getRepos: () => [REPO],
      getRepo: (id: string) => (id === REPO.id ? REPO : undefined),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getProjects: () => [],
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      getWorkspaceSession: () => sessions.get(LOCAL_EXECUTION_HOST_ID)!,
      onWorkspaceSessionWritten: () => () => {}
    } as never
  )
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, { tabId: 'tab', leafId: LEAF })
  return runtime
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function paneOf(event: WorkspaceLayoutEvent): PublishedPane | undefined {
  return event.type === 'workspace' ? event.layout.tabs[0]?.terminal?.panes[0] : undefined
}

describe('live pane titles on the layout stream', () => {
  it('publishes the title a pane terminal sets, once per change', async () => {
    const runtime = runtimeWithPane()
    const events: WorkspaceLayoutEvent[] = []
    const { snapshot } = runtime.subscribeWorkspaceLayouts((event) => events.push(event))
    expect(snapshot.map((entry) => entry.key)).toEqual([WORKTREE_ID])
    expect(snapshot[0].layout.tabs[0]?.terminal?.panes[0]).toEqual({ leafId: LEAF, ptyId: PTY_ID })

    runtime.onPtyData(PTY_ID, '\x1b]0;npm run build\x07', Date.now())
    await flush()
    expect(events).toHaveLength(1)
    expect(paneOf(events[0])).toEqual({ leafId: LEAF, ptyId: PTY_ID, liveTitle: 'npm run build' })

    // The same title again is no change.
    runtime.onPtyData(PTY_ID, '\x1b]0;npm run build\x07', Date.now())
    await flush()
    expect(events).toHaveLength(1)
  })

  it('sends no frame per spinner glyph while an agent works', async () => {
    const runtime = runtimeWithPane()
    const events: WorkspaceLayoutEvent[] = []
    runtime.subscribeWorkspaceLayouts((event) => events.push(event))
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    for (let frame = 0; frame < 100; frame++) {
      runtime.onPtyData(
        PTY_ID,
        `\x1b]0;${spinner[frame % spinner.length]} Fix the build\x07`,
        Date.now()
      )
      await flush()
    }
    expect(events.map((event) => paneOf(event)?.liveTitle)).toEqual(['⠋ Fix the build'])
  })
})
