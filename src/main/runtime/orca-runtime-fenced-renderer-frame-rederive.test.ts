import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'

const WORKTREE_ID = 'repo::/worktree'
const REPO_ID = 'repo'
const LIVE_REPO = {
  id: REPO_ID,
  path: '/worktree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
} as const
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const SPLIT_ROOT = {
  type: 'split' as const,
  direction: 'vertical' as const,
  first: { type: 'leaf' as const, leafId: LEFT },
  second: { type: 'leaf' as const, leafId: RIGHT }
}

// A cold restore: the persisted split survives, and an earlier incarnation change left the repo's
// terminal membership host-authoritative, but no PTY has registered yet.
function makeColdRestoredSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: 'pty-left',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: SPLIT_ROOT,
        activeLeafId: LEFT,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
      }
    },
    terminalTopologyRevisionByRepoId: { [REPO_ID]: 2 }
  }
}

function makeRendererFrame(): RuntimeMobileSessionTabsSnapshot {
  const parentLayout = {
    root: SPLIT_ROOT,
    activeLeafId: LEFT,
    expandedLeafId: LEFT,
    ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
  }
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: `tab::${LEFT}`,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group', activeTabId: 'tab', tabOrder: ['tab'] }],
    tabs: [
      {
        type: 'terminal',
        id: `tab::${LEFT}`,
        parentTabId: 'tab',
        leafId: LEFT,
        ptyId: 'pty-left',
        title: 'Left',
        parentLayout,
        isActive: true
      },
      {
        type: 'terminal',
        id: `tab::${RIGHT}`,
        parentTabId: 'tab',
        leafId: RIGHT,
        ptyId: 'pty-right',
        title: 'Right',
        parentLayout,
        isActive: false
      }
    ]
  }
}

function publishRendererFrame(runtime: OrcaRuntimeService): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEFT,
        layout: SPLIT_ROOT
      }
    ],
    leaves: [],
    mobileSessionTabs: [makeRendererFrame()]
  })
}

function coldRestoredRuntime(): OrcaRuntimeService {
  const session = makeColdRestoredSession()
  // The desktop window is live, so main must not rebuild the list from the persisted session.
  setRuntimeDesktopSurface({
    showNotification: () => false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only isDestroyed off its authoritative window on this path.
    findWindowById: () => ({ isDestroyed: () => false }) as never,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list and fence paths read only repos and the workspace session; the rest of Store is unreached.
    {
      getRepos: () => [LIVE_REPO],
      getWorkspaceSession: () => session,
      // The production store commits asynchronously; a synchronous flush on this path is a bug.
      flushOrThrow: () => {
        throw new Error('synchronous flush')
      }
    } as never
  )
  runtime.attachWindow(1)
  return runtime
}

async function listedSurfaces(runtime: OrcaRuntimeService): Promise<string[]> {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  return result.tabs.map((tab) => `${tab.id}:${'status' in tab ? tab.status : ''}`)
}

describe('a renderer frame fenced before its PTY registered', () => {
  afterEach(() => setRuntimeDesktopSurface(null))

  it.each([
    ['local', null],
    ['SSH', 'ssh-1']
  ])('%s: re-derives the fence once the PTY registers', async (_host, connectionId) => {
    const runtime = coldRestoredRuntime()
    publishRendererFrame(runtime)
    expect(await listedSurfaces(runtime)).toEqual([])
    const published: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => published.push(event))

    runtime.registerPty('pty-left', WORKTREE_ID, connectionId, {
      tabId: 'tab',
      leafId: LEFT,
      incarnationId: 'incarnation-restored'
    })

    expect(published.at(-1)?.tabs.map((tab) => tab.id)).toEqual([`tab::${LEFT}`])
    expect(await listedSurfaces(runtime)).toEqual([`tab::${LEFT}:ready`])
    // The renderer's unchanged resend must not undo or churn the re-derived list.
    publishRendererFrame(runtime)
    expect(await listedSurfaces(runtime)).toEqual([`tab::${LEFT}:ready`])
    unsubscribe()
  })

  it('keeps a surface whose PTY never returns fenced when a sibling registers', async () => {
    const runtime = coldRestoredRuntime()
    publishRendererFrame(runtime)

    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: LEFT,
      incarnationId: 'incarnation-restored'
    })
    runtime.registerPty('pty-other', WORKTREE_ID, null, {
      tabId: 'tab-other',
      leafId: RIGHT,
      incarnationId: 'incarnation-other'
    })

    expect(await listedSurfaces(runtime)).toEqual([`tab::${LEFT}:ready`])
  })
})
