import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'

const WORKTREE_ID = 'repo::/worktree'
const REPO_ID = 'repo'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const SPLIT_ROOT = {
  type: 'split' as const,
  direction: 'vertical' as const,
  first: { type: 'leaf' as const, leafId: LEFT },
  second: { type: 'leaf' as const, leafId: RIGHT }
}

type RestoreHost = {
  repo: {
    id: string
    path: string
    displayName: string
    badgeColor: string
    addedAt: number
    connectionId?: string
    executionHostId?: ExecutionHostId
  }
  hostId: ExecutionHostId
  connectionId: string | null
  ptyIds: { left: string; right: string }
  /** An SSH relaunch has not bound its PTY into the saved session yet. */
  persistsPtyBindings: boolean
}

const LOCAL_HOST: RestoreHost = {
  repo: { id: REPO_ID, path: '/worktree', displayName: 'repo', badgeColor: 'blue', addedAt: 1 },
  hostId: LOCAL_EXECUTION_HOST_ID,
  connectionId: null,
  ptyIds: { left: 'pty-left', right: 'pty-right' },
  persistsPtyBindings: true
}
const SSH_HOST: RestoreHost = {
  repo: { ...LOCAL_HOST.repo, connectionId: 'ssh-1' },
  hostId: 'ssh:ssh-1',
  connectionId: 'ssh-1',
  ptyIds: { left: 'ssh:ssh-1@@pty-left', right: 'ssh:ssh-1@@pty-right' },
  persistsPtyBindings: false
}
const RUNTIME_HOST: RestoreHost = {
  ...LOCAL_HOST,
  repo: { ...LOCAL_HOST.repo, executionHostId: 'runtime:env-1' },
  hostId: 'runtime:env-1'
}

// A cold restore: the saved split survives, and an earlier incarnation change left the repo's
// terminal membership host-authoritative, but no PTY has registered yet.
function makeColdRestoredSession(host: RestoreHost): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: host.persistsPtyBindings ? host.ptyIds.left : null,
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
        ptyIdsByLeafId: host.persistsPtyBindings
          ? { [LEFT]: host.ptyIds.left, [RIGHT]: host.ptyIds.right }
          : {}
      }
    },
    terminalTopologyRevisionByRepoId: { [REPO_ID]: 2 }
  }
}

function makeRendererFrame(
  host: RestoreHost,
  options: {
    version?: number
    leaves?: readonly string[]
    extraTabs?: readonly RuntimeMobileSessionSnapshotTab[]
  } = {}
): RuntimeMobileSessionTabsSnapshot {
  const leaves = options.leaves ?? [LEFT, RIGHT]
  const ptyIdByLeaf: Record<string, string> = {
    [LEFT]: host.ptyIds.left,
    [RIGHT]: host.ptyIds.right
  }
  const parentLayout = {
    root: leaves.length === 2 ? SPLIT_ROOT : { type: 'leaf' as const, leafId: leaves[0] },
    activeLeafId: leaves[0],
    expandedLeafId: leaves[0],
    ptyIdsByLeafId: Object.fromEntries(leaves.map((leafId) => [leafId, ptyIdByLeaf[leafId]]))
  }
  const extraTabs = options.extraTabs ?? []
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: options.version ?? 1,
    activeGroupId: 'group',
    activeTabId: `tab::${leaves[0]}`,
    activeTabType: 'terminal',
    tabGroups: [
      { id: 'group', activeTabId: 'tab', tabOrder: ['tab', ...extraTabs.map((tab) => tab.id)] }
    ],
    tabs: [
      ...leaves.map((leafId, index) => ({
        type: 'terminal' as const,
        id: `tab::${leafId}`,
        parentTabId: 'tab',
        leafId,
        ptyId: ptyIdByLeaf[leafId],
        title: leafId === LEFT ? 'Left' : 'Right',
        parentLayout,
        isActive: index === 0
      })),
      ...extraTabs
    ]
  }
}

const RENDERER_TABS = [
  {
    tabId: 'tab',
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    activeLeafId: LEFT,
    layout: SPLIT_ROOT
  }
]

function publishRendererFrame(
  runtime: OrcaRuntimeService,
  frame: RuntimeMobileSessionTabsSnapshot
): ReturnType<OrcaRuntimeService['syncWindowGraph']> {
  return runtime.syncWindowGraph(1, { tabs: RENDERER_TABS, leaves: [], mobileSessionTabs: [frame] })
}

function coldRestoredRuntime(host: RestoreHost = LOCAL_HOST): {
  runtime: OrcaRuntimeService
  sessions: Map<ExecutionHostId, WorkspaceSessionState>
} {
  const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
    [host.hostId, makeColdRestoredSession(host)]
  ])
  // The desktop window is live, so main must not rebuild the list from the saved session.
  const liveWindow = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: () => {} }
  }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only liveness and send off its authoritative window on these paths.
    findWindowById: () => liveWindow as never,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list, fence, exit and close paths read only repos and the workspace session; the rest of Store is unreached.
    withDurableRuntimeStore({
      getRepos: () => [host.repo],
      getRepo: (id: string) => (id === REPO_ID ? host.repo : undefined),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getProjects: () => [],
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      getWorkspaceSession: (hostId?: ExecutionHostId) =>
        sessions.get(hostId ?? LOCAL_EXECUTION_HOST_ID) ?? getDefaultWorkspaceSession(),
      setWorkspaceSession: (next: WorkspaceSessionState, hostId?: ExecutionHostId) => {
        sessions.set(hostId ?? LOCAL_EXECUTION_HOST_ID, next)
      },
      flushPendingOrThrowAsync: async () => {},
      // The production store commits asynchronously; a synchronous flush on these paths is a bug.
      flushOrThrow: () => {
        throw new Error('synchronous flush')
      }
    }) as never
  )
  runtime.attachWindow(1)
  return { runtime, sessions }
}

function registerLeaf(runtime: OrcaRuntimeService, host: RestoreHost, leaf: 'left' | 'right') {
  runtime.registerPty(host.ptyIds[leaf], WORKTREE_ID, host.connectionId, {
    tabId: 'tab',
    leafId: leaf === 'left' ? LEFT : RIGHT,
    incarnationId: `incarnation-${leaf}`
  })
}

function surfaces(result: RuntimeMobileSessionTabsResult | undefined): string[] {
  return (result?.tabs ?? []).map((tab) => `${tab.id}:${'status' in tab ? tab.status : ''}`)
}

async function listedSurfaces(runtime: OrcaRuntimeService): Promise<string[]> {
  return surfaces(await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`))
}

// The session-tabs notify coalescer's max wait (mobile-session-tabs-notify-coalescer.ts).
const COALESCED_PUSH_MS = 250

describe('a restored terminal published before its PTY registers', () => {
  afterEach(() => {
    setRuntimeDesktopSurface(null)
    vi.useRealTimers()
  })

  it.each([
    ['local', LOCAL_HOST],
    ['SSH without a saved PTY binding', SSH_HOST],
    ['runtime host', RUNTIME_HOST]
  ])('%s: is listed pending, then pushed ready when its PTY registers', async (_label, host) => {
    vi.useFakeTimers()
    const { runtime } = coldRestoredRuntime(host)
    publishRendererFrame(runtime, makeRendererFrame(host))
    expect(await listedSurfaces(runtime)).toEqual([
      `tab::${LEFT}:pending-handle`,
      `tab::${RIGHT}:pending-handle`
    ])
    vi.advanceTimersByTime(COALESCED_PUSH_MS)
    const published: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => published.push(event))

    registerLeaf(runtime, host, 'left')
    vi.advanceTimersByTime(COALESCED_PUSH_MS)

    // Registration alone reaches clients: no renderer frame or graph change follows it here.
    expect(surfaces(published.at(-1))).toEqual([
      `tab::${LEFT}:ready`,
      `tab::${RIGHT}:pending-handle`
    ])
    const pushes = published.length
    expect(
      runtime.syncWindowGraph(1, {
        tabs: RENDERER_TABS,
        leaves: [],
        mobileSessionTabs: [],
        unchangedMobileSessionWorktrees: [WORKTREE_ID]
      }).mobileSessionResyncWorktrees
    ).toBeUndefined()
    publishRendererFrame(runtime, makeRendererFrame(host))
    vi.advanceTimersByTime(COALESCED_PUSH_MS)
    expect(published).toHaveLength(pushes)
    expect(await listedSurfaces(runtime)).toEqual([
      `tab::${LEFT}:ready`,
      `tab::${RIGHT}:pending-handle`
    ])

    registerLeaf(runtime, host, 'right')
    vi.advanceTimersByTime(COALESCED_PUSH_MS)

    expect(surfaces(published.at(-1))).toEqual([`tab::${LEFT}:ready`, `tab::${RIGHT}:ready`])
    unsubscribe()
  })

  it('pushes a restore of several panes once, not once per registering pane', () => {
    vi.useFakeTimers()
    const { runtime } = coldRestoredRuntime()
    publishRendererFrame(runtime, makeRendererFrame(LOCAL_HOST))
    vi.advanceTimersByTime(COALESCED_PUSH_MS)
    const published: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => published.push(event))

    registerLeaf(runtime, LOCAL_HOST, 'left')
    registerLeaf(runtime, LOCAL_HOST, 'right')
    vi.advanceTimersByTime(COALESCED_PUSH_MS)

    expect(published.map(surfaces)).toEqual([[`tab::${LEFT}:ready`, `tab::${RIGHT}:ready`]])
    unsubscribe()
  })

  it('keeps listing a restored pane whose PTY never returns as pending', async () => {
    const { runtime } = coldRestoredRuntime()
    publishRendererFrame(runtime, makeRendererFrame(LOCAL_HOST))

    registerLeaf(runtime, LOCAL_HOST, 'left')
    runtime.registerPty('pty-other', WORKTREE_ID, null, {
      tabId: 'tab-other',
      leafId: RIGHT,
      incarnationId: 'incarnation-other'
    })

    expect(await listedSurfaces(runtime)).toEqual([
      `tab::${LEFT}:ready`,
      `tab::${RIGHT}:pending-handle`
    ])
  })
})

describe('a retired restored terminal stays out of a later renderer frame', () => {
  afterEach(() => setRuntimeDesktopSurface(null))

  it('after its process exits and the retirement is saved', async () => {
    const { runtime, sessions } = coldRestoredRuntime()
    registerLeaf(runtime, LOCAL_HOST, 'left')
    publishRendererFrame(runtime, makeRendererFrame(LOCAL_HOST))
    expect(await listedSurfaces(runtime)).toContain(`tab::${LEFT}:ready`)

    await runtime.onPtyExit('pty-left', 0, 'incarnation-left')

    expect(sessions.get(LOCAL_EXECUTION_HOST_ID)?.terminalLayoutsByTabId.tab?.root).toEqual({
      type: 'leaf',
      leafId: RIGHT
    })
    // A lagging renderer still lists the exited pane, at a newer version.
    publishRendererFrame(runtime, makeRendererFrame(LOCAL_HOST, { version: 2 }))
    expect(await listedSurfaces(runtime)).not.toContain(`tab::${LEFT}:ready`)
    expect(await listedSurfaces(runtime)).not.toContain(`tab::${LEFT}:pending-handle`)
  })

  it('after its last pane exits from a runtime-host partition an older copy still lists', async () => {
    const { runtime, sessions } = coldRestoredRuntime(RUNTIME_HOST)
    // Left behind in another partition before the catalog owner rotated.
    sessions.set(LOCAL_EXECUTION_HOST_ID, makeColdRestoredSession(RUNTIME_HOST))
    registerLeaf(runtime, RUNTIME_HOST, 'left')
    registerLeaf(runtime, RUNTIME_HOST, 'right')
    publishRendererFrame(runtime, makeRendererFrame(RUNTIME_HOST))

    await runtime.onPtyExit('pty-left', 0, 'incarnation-left')
    await runtime.onPtyExit('pty-right', 0, 'incarnation-right')
    // Emptying the owner's partition re-routes reads to the older copy.
    expect(sessions.get(RUNTIME_HOST.hostId)?.tabsByWorktree[WORKTREE_ID]).toEqual([])

    publishRendererFrame(runtime, makeRendererFrame(RUNTIME_HOST, { version: 2 }))
    expect(await listedSurfaces(runtime)).toEqual([])
  })

  it('after the user closes it on the desktop', async () => {
    const { runtime, sessions } = coldRestoredRuntime()
    registerLeaf(runtime, LOCAL_HOST, 'left')
    registerLeaf(runtime, LOCAL_HOST, 'right')
    publishRendererFrame(runtime, makeRendererFrame(LOCAL_HOST))
    expect(await listedSurfaces(runtime)).toEqual([`tab::${LEFT}:ready`, `tab::${RIGHT}:ready`])

    publishRendererFrame(runtime, makeRendererFrame(LOCAL_HOST, { version: 2, leaves: [LEFT] }))
    await runtime.onPtyExit('pty-right', 0, 'incarnation-right')
    expect(sessions.get(LOCAL_EXECUTION_HOST_ID)?.terminalLayoutsByTabId.tab?.root).toEqual({
      type: 'leaf',
      leafId: LEFT
    })

    publishRendererFrame(runtime, makeRendererFrame(LOCAL_HOST, { version: 3 }))
    expect(await listedSurfaces(runtime)).toEqual([`tab::${LEFT}:ready`])
  })
})

// An SSH worktree: the phone closes a tab while a relaunched sibling tab has not registered yet.
const SSH_PTY_X = 'ssh:ssh-1@@pty-x'
const SSH_PTY_Y = 'ssh:ssh-1@@pty-y'

function makeSshSession(tabIds: readonly ('tab-x' | 'tab-y')[]): WorkspaceSessionState {
  // tab-x's relaunched PTY has not bound yet, so only tab-y saves a relay binding.
  const specs = {
    'tab-x': { leafId: LEFT, ptyId: null },
    'tab-y': { leafId: RIGHT, ptyId: SSH_PTY_Y }
  }
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: tabIds.map((id, index) => ({
        id,
        ptyId: specs[id].ptyId,
        worktreeId: WORKTREE_ID,
        title: id,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: index + 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      tabIds.map((id) => [
        id,
        {
          root: { type: 'leaf' as const, leafId: specs[id].leafId },
          activeLeafId: specs[id].leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: specs[id].ptyId ? { [specs[id].leafId]: specs[id].ptyId } : {}
        }
      ])
    ),
    terminalTopologyRevisionByRepoId: { [REPO_ID]: 2 }
  }
}

function publishSshRendererFrame(runtime: OrcaRuntimeService): void {
  const tabs = [
    { tabId: 'tab-x', leafId: LEFT, ptyId: SSH_PTY_X },
    { tabId: 'tab-y', leafId: RIGHT, ptyId: SSH_PTY_Y }
  ]
  runtime.syncWindowGraph(1, {
    tabs: tabs.map(({ tabId, leafId }) => ({
      tabId,
      worktreeId: WORKTREE_ID,
      title: tabId,
      activeLeafId: leafId,
      layout: { type: 'leaf' as const, leafId }
    })),
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: WORKTREE_ID,
        publicationEpoch: 'renderer',
        snapshotVersion: 1,
        activeGroupId: 'group',
        activeTabId: `tab-y::${RIGHT}`,
        activeTabType: 'terminal',
        tabGroups: [{ id: 'group', activeTabId: 'tab-y', tabOrder: ['tab-x', 'tab-y'] }],
        tabs: tabs.map(({ tabId, leafId, ptyId }) => ({
          type: 'terminal' as const,
          id: `${tabId}::${leafId}`,
          parentTabId: tabId,
          leafId,
          ptyId,
          title: tabId,
          isActive: tabId === 'tab-y'
        }))
      }
    ]
  })
}

describe('a surface the host retired stays retired when a restored sibling registers', () => {
  afterEach(() => setRuntimeDesktopSurface(null))

  it('keeps a phone-closed SSH terminal closed while its remote PTY is still exiting', async () => {
    const { runtime, sessions } = coldRestoredRuntime(SSH_HOST)
    sessions.set(SSH_HOST.hostId, makeSshSession(['tab-x', 'tab-y']))
    const kill = vi.fn(() => true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close path uses only these two relays.
    runtime.setNotifier({
      closeTerminal: vi.fn(),
      // The renderer durably retires the tab and acks; its pruned frame is still in flight.
      closeTerminalTab: vi.fn(async () => {
        sessions.set(SSH_HOST.hostId, makeSshSession(['tab-x']))
      })
    } as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close path kills and inventories only; the remote kill lands asynchronously.
    runtime.setPtyController({
      write: () => true,
      kill,
      listProcesses: vi.fn(async () =>
        [SSH_PTY_X, SSH_PTY_Y].map((id) => ({ id, cwd: '/worktree', title: 'shell' }))
      ),
      getForegroundProcess: async () => null
    } as never)
    publishSshRendererFrame(runtime)
    runtime.registerPty(SSH_PTY_Y, WORKTREE_ID, 'ssh-1', {
      tabId: 'tab-y',
      leafId: RIGHT,
      incarnationId: 'incarnation-y'
    })
    expect(await listedSurfaces(runtime)).toContain(`tab-y::${RIGHT}:ready`)

    await runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, 'tab-y', { reason: 'user' })
    expect(kill).toHaveBeenCalledWith(SSH_PTY_Y)
    runtime.registerPty(SSH_PTY_X, WORKTREE_ID, 'ssh-1', {
      tabId: 'tab-x',
      leafId: LEFT,
      incarnationId: 'incarnation-x'
    })

    expect(await listedSurfaces(runtime)).not.toContain(`tab-y::${RIGHT}:ready`)
  })

  it('keeps a phone-closed chat tab closed', async () => {
    const { runtime } = coldRestoredRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat close path uses only this relay.
    runtime.setNotifier({ closeSessionTab: vi.fn(async () => {}) } as never)
    publishRendererFrame(
      runtime,
      makeRendererFrame(LOCAL_HOST, {
        extraTabs: [
          {
            type: 'agent-session',
            id: 'chat',
            title: 'Chat',
            sessionId: 'session-chat',
            agent: 'claude',
            isActive: false
          }
        ]
      })
    )
    expect(await listedSurfaces(runtime)).toContain('chat:')

    await runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, 'chat', { reason: 'user' })
    registerLeaf(runtime, LOCAL_HOST, 'left')

    expect(await listedSurfaces(runtime)).not.toContain('chat:')
  })
})

// A phone creates a terminal while the desktop's frame still lacks it: the spawn registered and the
// host published the tab itself, as it does for a create the desktop has not published yet.
const PHONE_LEAF = '33333333-3333-4333-8333-333333333333'

async function runtimeWithUnpublishedPhoneCreate(): Promise<OrcaRuntimeService> {
  const { runtime } = coldRestoredRuntime()
  const handlers = new Map<string, (event: unknown, reply: unknown) => void>()
  const webContents = {
    isDestroyed: () => false,
    setBackgroundThrottling: () => {},
    capturePage: async () => null,
    send: (channel: string, payload: { requestId: string }) => {
      if (channel !== 'terminal:requestTabCreate') {
        return
      }
      runtime.registerPty('pty-phone', WORKTREE_ID, null, {
        tabId: 'tab-phone',
        leafId: PHONE_LEAF,
        incarnationId: 'incarnation-phone'
      })
      handlers.get('terminal:tabCreateReply')?.(
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-phone', title: 'Terminal' }
      )
    }
  }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path reads only liveness and these webContents members off its authoritative window.
    findWindowById: () => ({ isDestroyed: () => false, webContents }) as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the tab-create reply channel is registered on this path.
    onIpc: (channel, listener) => handlers.set(channel, listener as never),
    removeIpcListener: (channel) => handlers.delete(channel)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path focuses only when activating, which this create does not.
  runtime.setNotifier({ focusTerminal: vi.fn() } as never)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: WORKTREE_ID,
      path: '/worktree',
      connectionId: null,
      repo: LOCAL_HOST.repo,
      folderWorkspace: null
    }))
  })
  publishRendererFrame(runtime, makeRendererFrame(LOCAL_HOST))
  await runtime.createMobileSessionTerminal(`id:${WORKTREE_ID}`, {
    activate: false,
    clientNavigationId: 'phone'
  })
  return runtime
}

describe('a surface the host added stays listed when a restored sibling registers', () => {
  afterEach(() => setRuntimeDesktopSurface(null))

  it('keeps a phone-created terminal listed', async () => {
    const runtime = await runtimeWithUnpublishedPhoneCreate()
    expect(await listedSurfaces(runtime)).toContain(`tab-phone::${PHONE_LEAF}:ready`)

    registerLeaf(runtime, LOCAL_HOST, 'left')

    expect(await listedSurfaces(runtime)).toContain(`tab-phone::${PHONE_LEAF}:ready`)
  })
})
