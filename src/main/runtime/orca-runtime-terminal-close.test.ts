import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo-1::/tmp/worktree'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_TAB_ID = '22222222-2222-4222-8222-222222222222'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'

function registerPtyBackedHandle(
  runtime: OrcaRuntimeService,
  options: { tabId?: string } = { tabId: TAB_ID }
): string {
  const handle = runtime.createPreAllocatedTerminalHandle()
  runtime.registerPreAllocatedHandleForPty('pty-1', handle)
  runtime.registerPty(
    'pty-1',
    WORKTREE_ID,
    null,
    options.tabId ? { tabId: options.tabId, leafId: LEAF_ID } : undefined
  )
  return handle
}

function registerGraphBackedHandle(runtime: OrcaRuntimeService): string {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 7,
        ptyId: 'pty-graph',
        paneTitle: 'Terminal'
      }
    ]
  })
  return runtime.resolveTerminalPane(makePaneKey(TAB_ID, LEAF_ID)).handle
}

function attachCloseNotifier(runtime: OrcaRuntimeService, closeTerminal: ReturnType<typeof vi.fn>) {
  runtime.setNotifier({ closeTerminal } as never)
}

function createDormantRuntimeTerminal(
  options: { graphReady?: boolean; isPinned?: boolean; persistedPtyId?: string } = {}
): {
  runtime: OrcaRuntimeService
  handle: string
  getSession: () => WorkspaceSessionState
} {
  const persistedPtyId = options.persistedPtyId ?? 'pty-1'
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE_ID,
    activeTabId: TAB_ID,
    activeTabIdByWorktree: { [WORKTREE_ID]: TAB_ID },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: persistedPtyId,
          worktreeId: WORKTREE_ID,
          title: 'Dormant Terminal',
          customTitle: null,
          color: null,
          ...(options.isPinned ? { isPinned: true } : {}),
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: persistedPtyId }
      }
    }
  }
  const runtime = new OrcaRuntimeService({
    getRepos: () => [],
    getWorktreeMeta: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  } as never)
  const handle = registerPtyBackedHandle(runtime)
  if (options.graphReady !== false) {
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  }
  return { runtime, handle, getSession: () => session }
}

describe('terminal close modes', () => {
  it('keeps the default PTY-first close behavior', async () => {
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ kill } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerPtyBackedHandle(runtime)

    await expect(runtime.closeTerminal(handle)).resolves.toEqual({
      handle,
      tabId: TAB_ID,
      closeMode: 'terminal',
      tabCloseRequested: false,
      ptyKilled: true
    })
    expect(kill).toHaveBeenCalledOnce()
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('requests one renderer tab close for a live PTY without killing it first', async () => {
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ kill } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerPtyBackedHandle(runtime)

    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toEqual({
      handle,
      tabId: TAB_ID,
      closeMode: 'tab',
      tabCloseRequested: true,
      ptyKilled: false
    })
    expect(closeTerminal).toHaveBeenCalledOnce()
    expect(closeTerminal).toHaveBeenCalledWith(TAB_ID)
    expect(kill).not.toHaveBeenCalled()
  })

  it('requests one renderer tab close for a graph-backed handle', async () => {
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ kill } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerGraphBackedHandle(runtime)

    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toMatchObject({
      handle,
      tabId: TAB_ID,
      closeMode: 'tab',
      tabCloseRequested: true,
      ptyKilled: false
    })
    expect(closeTerminal).toHaveBeenCalledOnce()
    expect(closeTerminal).toHaveBeenCalledWith(TAB_ID)
    expect(kill).not.toHaveBeenCalled()
  })

  it('authoritatively closes an exact dormant terminal absent from the renderer graph', async () => {
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill, stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toEqual({
      handle,
      tabId: TAB_ID,
      closeMode: 'tab',
      tabCloseRequested: true,
      ptyKilled: true
    })
    expect(stopAndWait).toHaveBeenCalledOnce()
    expect(stopAndWait).toHaveBeenCalledWith('pty-1')
    expect(kill).not.toHaveBeenCalled()
    expect(closeTerminal).toHaveBeenCalledWith(TAB_ID)
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId[TAB_ID]).toBeUndefined()
    await expect(runtime.listTerminals(`id:${WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [],
      totalCount: 0
    })
  })

  it('fails closed for a pinned dormant terminal', async () => {
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession } = createDormantRuntimeTerminal({ isPinned: true })
    runtime.setPtyController({ kill, stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_identity_ambiguous'
    )
    expect(kill).not.toHaveBeenCalled()
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('fails closed when dormant persistence points to a replacement PTY', async () => {
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession } = createDormantRuntimeTerminal({
      persistedPtyId: 'pty-replacement'
    })
    runtime.setPtyController({ kill, stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_identity_ambiguous'
    )
    expect(kill).not.toHaveBeenCalled()
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('keeps dormant inventory when the PTY controller cannot confirm the kill', async () => {
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => false)
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill, stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_close_unavailable'
    )
    expect(stopAndWait).toHaveBeenCalledWith('pty-1')
    expect(kill).not.toHaveBeenCalled()
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    await expect(runtime.listTerminals(`id:${WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [expect.objectContaining({ handle, ptyId: 'pty-1' })],
      totalCount: 1
    })
  })

  it('fails closed while renderer ownership is unavailable', async () => {
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession } = createDormantRuntimeTerminal({ graphReady: false })
    runtime.setPtyController({ kill, stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_close_unavailable'
    )
    expect(kill).not.toHaveBeenCalled()
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('fails closed when tab close has no attached renderer notifier', async () => {
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ kill } as never)
    const handle = registerPtyBackedHandle(runtime)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_close_unavailable'
    )
    expect(kill).not.toHaveBeenCalled()
  })

  it('rejects an unsealed or malformed handle before requesting a tab close', async () => {
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal('not-a-terminal-handle', 'tab')).rejects.toThrow(
      'terminal_handle_stale'
    )
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('rejects a live PTY whose sealed handle has no renderer tab identity', async () => {
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerPtyBackedHandle(runtime, { tabId: undefined })

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_identity_missing'
    )
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('rejects conflicting tab identities instead of choosing one', async () => {
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerPtyBackedHandle(runtime)
    const internals = runtime as unknown as {
      ptysById: Map<string, { paneKey: string | null }>
    }
    internals.ptysById.get('pty-1')!.paneKey = makePaneKey(OTHER_TAB_ID, LEAF_ID)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_identity_ambiguous'
    )
    expect(closeTerminal).not.toHaveBeenCalled()
  })
})
