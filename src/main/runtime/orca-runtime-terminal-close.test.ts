import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type {
  BrowserPage,
  BrowserWorkspace,
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo-1::/tmp/worktree'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_TAB_ID = '22222222-2222-4222-8222-222222222222'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'
const SURVIVOR_TAB_ID = '44444444-4444-4444-8444-444444444444'
const SURVIVOR_LEAF_ID = '55555555-5555-4555-8555-555555555555'
const MRU_TAB_ID = '66666666-6666-4666-8666-666666666666'
const MRU_LEAF_ID = '77777777-7777-4777-8777-777777777777'

function rendererGraph(ptyId: string, title = 'Terminal', paneRuntimeId = 7) {
  // prettier-ignore
  const graph = { tabs: [{ tabId: TAB_ID, worktreeId: WORKTREE_ID, title, activeLeafId: LEAF_ID, layout: null }], leaves: [{ tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId, ptyId, paneTitle: title }] } satisfies Parameters<OrcaRuntimeService['syncWindowGraph']>[1]
  return graph
}

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
  runtime.syncWindowGraph(1, rendererGraph('pty-graph'))
  return runtime.resolveTerminalPane(makePaneKey(TAB_ID, LEAF_ID)).handle
}

function attachCloseNotifier(runtime: OrcaRuntimeService, closeTerminal: ReturnType<typeof vi.fn>) {
  runtime.setNotifier({ closeTerminal } as never)
}

function createDormantRuntimeTerminal(
  options: {
    graphReady?: boolean
    getter?: 'missing'
    isPinned?: boolean
    persistedPtyId?: string
    setter?: 'missing' | 'noop' | 'throw' | 'reappear' | 'rollback-incomplete'
    commitProjection?: (session: WorkspaceSessionState) => WorkspaceSessionState
    beforeCommit?: () => void
  } = {}
): {
  runtime: OrcaRuntimeService
  handle: string
  getSession: () => WorkspaceSessionState
  setPersistenceBehavior: (
    next: 'missing' | 'noop' | 'throw' | 'reappear' | 'rollback-incomplete' | undefined
  ) => void
  setSession: (next: WorkspaceSessionState) => void
} {
  const persistedPtyId = options.persistedPtyId ?? 'pty-1'
  let persistenceBehavior = options.setter
  // prettier-ignore
  const persisted = { activeWorktreeId: WORKTREE_ID, activeTabId: TAB_ID, activeTabIdByWorktree: { [WORKTREE_ID]: TAB_ID }, tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID, ptyId: persistedPtyId, worktreeId: WORKTREE_ID, title: 'Dormant Terminal', customTitle: null, color: null, sortOrder: 0, createdAt: 1 }] }, terminalLayoutsByTabId: { [TAB_ID]: { root: { type: 'leaf' as const, leafId: LEAF_ID }, activeLeafId: LEAF_ID, expandedLeafId: null, ptyIdsByLeafId: { [LEAF_ID]: persistedPtyId } } } } satisfies Partial<WorkspaceSessionState>
  let session = { ...getDefaultWorkspaceSession(), ...persisted } as WorkspaceSessionState
  if (options.isPinned) {
    session.tabsByWorktree[WORKTREE_ID]![0]!.isPinned = true
  }
  const store = {
    getRepos: () => [],
    getWorktreeMeta: () => undefined,
    getAllWorktreeMeta: () => ({}),
    ...(options.getter === 'missing' ? {} : { getWorkspaceSession: () => session }),
    ...(persistenceBehavior === 'missing'
      ? {}
      : {
          removeWorkspaceSessionTerminalTabAndFlush: (
            identity: {
              worktreeId: string
              tabId: string
              createdAt: number
              leafId: string
              ptyId: string
            },
            validatePreCommit?: () => void
          ) => {
            options.beforeCommit?.()
            validatePreCommit?.()
            if (persistenceBehavior === 'throw') {
              throw new Error('write_failed')
            }
            if (persistenceBehavior === 'rollback-incomplete') {
              throw new Error('terminal_tab_removal_rollback_incomplete')
            }
            if (persistenceBehavior === 'noop' || persistenceBehavior === 'reappear') {
              return undefined
            }
            const tabs = session.tabsByWorktree[identity.worktreeId] ?? []
            const nextLayouts = { ...session.terminalLayoutsByTabId }
            delete nextLayouts[identity.tabId]
            session = {
              ...session,
              tabsByWorktree: {
                ...session.tabsByWorktree,
                [identity.worktreeId]: tabs.filter((tab) => tab.id !== identity.tabId)
              },
              terminalLayoutsByTabId: nextLayouts
            }
            session = options.commitProjection?.(session) ?? session
            return { ...identity, durableRemoval: true as const }
          }
        })
  }
  const runtime = new OrcaRuntimeService(store as never)
  const handle = registerPtyBackedHandle(runtime)
  if (options.graphReady !== false) {
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  }
  return {
    runtime,
    handle,
    getSession: () => session,
    setPersistenceBehavior: (next) => (persistenceBehavior = next),
    setSession: (next) => (session = next)
  }
}

function deferredStop(): {
  stopAndWait: ReturnType<typeof vi.fn>
  resolve: (stopped: boolean) => void
} {
  let resolve!: (stopped: boolean) => void
  const stopAndWait = vi.fn(
    () =>
      new Promise<boolean>((resolveStop) => {
        resolve = resolveStop
      })
  )
  return { stopAndWait, resolve: (stopped) => resolve(stopped) }
}

function expectPartialDormantClose(
  promise: Promise<unknown>,
  handle: string,
  durableRemoval: boolean | 'unknown' = false,
  causeMessage?: string
): Promise<unknown> {
  return expect(promise).rejects.toMatchObject({
    message: 'terminal_tab_close_partial',
    handle,
    tabId: TAB_ID,
    closeMode: 'tab',
    tabCloseRequested: false,
    ptyKilled: true,
    durableRemoval,
    ...(causeMessage ? { cause: { message: causeMessage } } : {})
  })
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

  it('requests one renderer tab close for a renderer-owned live PTY without killing it first', async () => {
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ kill } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerPtyBackedHandle(runtime)
    runtime.syncWindowGraph(0, rendererGraph('pty-1'))

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

  it('requires the exact durable removal transaction before stopping a dormant PTY', async () => {
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession } = createDormantRuntimeTerminal({ setter: 'missing' })
    runtime.setPtyController({ kill, stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_close_unavailable'
    )
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('requires a durable session getter before stopping a renderer-absent live PTY', async () => {
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle } = createDormantRuntimeTerminal({ getter: 'missing' })
    runtime.setPtyController({ kill, stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_close_unavailable'
    )
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('reports confirmed durable removal when the renderer notifier throws', async () => {
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn(() => {
      throw new Error('notifier_failed')
    })
    const { runtime, handle, getSession } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill, stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)
    runtime.onMobileSessionTabsChanged(() => {
      throw new Error('subscriber_failed')
    })

    await expectPartialDormantClose(
      runtime.closeTerminal(handle, 'tab'),
      handle,
      true,
      'notifier_failed'
    )
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId[TAB_ID]).toBeUndefined()
    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow('terminal_handle_stale')
    expect(stopAndWait).toHaveBeenCalledOnce()
    expect(kill).not.toHaveBeenCalled()
  })

  it('serializes exact concurrent closes and rejects conflicting identity before stop', async () => {
    const stop = deferredStop()
    const { runtime, handle, getSession, setSession } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill: vi.fn(), stopAndWait: stop.stopAndWait } as never)
    attachCloseNotifier(runtime, vi.fn())
    const first = runtime.closeTerminal(handle, 'tab')
    await vi.waitFor(() => expect(stop.stopAndWait).toHaveBeenCalledOnce())
    const original = structuredClone(getSession())
    const conflicting = structuredClone(original)
    conflicting.tabsByWorktree[WORKTREE_ID]![0]!.createdAt = 2
    setSession(conflicting)
    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_identity_ambiguous'
    )
    setSession(original)
    const second = runtime.closeTerminal(handle, 'tab')
    stop.resolve(true)
    await Promise.all([first, second])
    expect(stop.stopAndWait).toHaveBeenCalledOnce()
  })

  it.each(['preseeded', 'cold'] as const)(
    'rebuilds headless state from the committed nonterminal MRU and group projection with %s mobile state',
    async (mobileState) => {
      // prettier-ignore
      const fixture = { tabs: [{ id: SURVIVOR_TAB_ID, ptyId: null, worktreeId: WORKTREE_ID, title: 'Left', customTitle: null, color: null, sortOrder: 1, createdAt: 2 }, { id: MRU_TAB_ID, ptyId: null, worktreeId: WORKTREE_ID, title: 'MRU', customTitle: null, color: null, sortOrder: 2, createdAt: 3 }], layouts: { [SURVIVOR_TAB_ID]: { root: { type: 'leaf' as const, leafId: SURVIVOR_LEAF_ID }, activeLeafId: SURVIVOR_LEAF_ID, expandedLeafId: null, ptyIdsByLeafId: {} }, [MRU_TAB_ID]: { root: { type: 'leaf' as const, leafId: MRU_LEAF_ID }, activeLeafId: MRU_LEAF_ID, expandedLeafId: null, ptyIdsByLeafId: {} } }, groups: [{ id: 'group-left', worktreeId: WORKTREE_ID, activeTabId: SURVIVOR_TAB_ID, tabOrder: [SURVIVOR_TAB_ID], recentTabIds: [SURVIVOR_TAB_ID] }, { id: 'group-right', worktreeId: WORKTREE_ID, activeTabId: MRU_TAB_ID, tabOrder: [MRU_TAB_ID], recentTabIds: [MRU_TAB_ID] }], layout: { type: 'split' as const, direction: 'horizontal' as const, first: { type: 'leaf' as const, groupId: 'group-left' }, second: { type: 'leaf' as const, groupId: 'group-right' } } } satisfies { tabs: WorkspaceSessionState['tabsByWorktree'][string]; layouts: WorkspaceSessionState['terminalLayoutsByTabId']; groups: NonNullable<WorkspaceSessionState['tabGroups']>[string]; layout: NonNullable<WorkspaceSessionState['tabGroupLayouts']>[string] }
      // prettier-ignore
      const editor = { unified: { id: OTHER_TAB_ID, entityId: '/tmp/mru.ts', groupId: 'group-right', worktreeId: WORKTREE_ID, contentType: 'editor' as const, label: 'mru.ts', customLabel: null, color: null, sortOrder: 0, createdAt: 4 }, openFiles: { [WORKTREE_ID]: [{ filePath: '/tmp/mru.ts', relativePath: 'mru.ts', worktreeId: WORKTREE_ID, language: 'typescript' }] }, snapshot: { worktree: WORKTREE_ID, publicationEpoch: 'headless:test', snapshotVersion: 1, activeGroupId: 'group-right', activeTabId: OTHER_TAB_ID, activeTabType: 'file', tabs: [{ type: 'file', id: OTHER_TAB_ID, title: 'mru.ts', filePath: '/tmp/mru.ts', relativePath: 'mru.ts', language: 'typescript', isDirty: false, isActive: true }] } } satisfies { unified: NonNullable<WorkspaceSessionState['unifiedTabs']>[string][number]; openFiles: NonNullable<WorkspaceSessionState['openFilesByWorktree']>; snapshot: RuntimeMobileSessionTabsSnapshot }
      const commitProjection = (session: WorkspaceSessionState): WorkspaceSessionState => ({
        ...session,
        activeTabId: null,
        activeTabIdByWorktree: { [WORKTREE_ID]: null },
        activeFileIdByWorktree: { [WORKTREE_ID]: '/tmp/mru.ts' },
        activeTabTypeByWorktree: { [WORKTREE_ID]: 'editor' },
        unifiedTabs: { [WORKTREE_ID]: [editor.unified] },
        openFilesByWorktree: editor.openFiles,
        tabGroups: { [WORKTREE_ID]: fixture.groups },
        tabGroupLayouts: { [WORKTREE_ID]: fixture.layout },
        activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-right' }
      })
      const { runtime, handle, getSession } = createDormantRuntimeTerminal({ commitProjection })
      const initial = getSession()
      fixture.groups[1].activeTabId = OTHER_TAB_ID
      fixture.groups[1].tabOrder = [OTHER_TAB_ID]
      fixture.groups[1].recentTabIds = [OTHER_TAB_ID]
      initial.tabsByWorktree[WORKTREE_ID]!.push(...fixture.tabs)
      Object.assign(initial.terminalLayoutsByTabId, fixture.layouts)
      initial.unifiedTabs = commitProjection(initial).unifiedTabs
      initial.openFilesByWorktree = commitProjection(initial).openFilesByWorktree
      initial.tabGroups = { [WORKTREE_ID]: fixture.groups }
      initial.tabGroupLayouts = { [WORKTREE_ID]: fixture.layout }
      initial.activeGroupIdByWorktree = { [WORKTREE_ID]: 'group-right' }
      if (mobileState === 'preseeded') {
        ;(
          runtime as unknown as { mobileSessionTabsByWorktree: Map<string, object> }
        ).mobileSessionTabsByWorktree.set(WORKTREE_ID, {
          ...editor.snapshot,
          tabGroups: fixture.groups,
          tabGroupLayout: fixture.layout
        })
      }
      runtime.setPtyController({ kill: vi.fn(), stopAndWait: vi.fn(async () => true) } as never)
      attachCloseNotifier(runtime, vi.fn())

      await runtime.closeTerminal(handle, 'tab')
      const snapshot = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)

      expect(snapshot.activeGroupId).toBe('group-right')
      expect(snapshot.activeTabId).toBe(OTHER_TAB_ID)
      expect(snapshot.activeTabType).toBe('file')
      expect(snapshot.tabGroups?.map((group) => group.id)).toEqual(['group-left', 'group-right'])
      expect(snapshot.tabGroupLayout).toEqual(fixture.layout)
    }
  )

  it('rebuilds mixed legacy browser and file survivors without a live backend', async () => {
    const browserId = 'browser-legacy'
    const browserPageId = 'browser-page-legacy'
    const fileId = '/tmp/legacy.ts'
    // prettier-ignore
    const browser = { id: browserId, worktreeId: WORKTREE_ID, activePageId: browserPageId, pageIds: [browserPageId], title: 'Stale workspace title', url: 'about:blank', loading: false, faviconUrl: null, canGoBack: false, canGoForward: false, loadError: null, createdAt: 3 } satisfies BrowserWorkspace
    // prettier-ignore
    const page = { id: browserPageId, workspaceId: browserId, worktreeId: WORKTREE_ID, title: 'Durable Page', url: 'https://example.test/page', loading: true, faviconUrl: 'https://example.test/favicon.ico', canGoBack: true, canGoForward: true, loadError: null, createdAt: 4 } satisfies BrowserPage
    const file = {
      filePath: fileId,
      relativePath: 'legacy.ts',
      worktreeId: WORKTREE_ID,
      language: 'typescript'
    } satisfies PersistedOpenFile
    // prettier-ignore
    const projection = { activeTabId: null, activeBrowserTabId: browserId, activeFileId: fileId, activeTabType: 'browser', activeTabIdByWorktree: { [WORKTREE_ID]: null }, activeBrowserTabIdByWorktree: { [WORKTREE_ID]: browserId }, activeFileIdByWorktree: { [WORKTREE_ID]: fileId }, activeTabTypeByWorktree: { [WORKTREE_ID]: 'browser' as const }, unifiedTabs: { [WORKTREE_ID]: [] }, tabGroups: { [WORKTREE_ID]: [] }, tabGroupLayouts: {}, activeGroupIdByWorktree: {}, browserTabsByWorktree: { [WORKTREE_ID]: [browser, { ...browser }] }, browserPagesByWorkspace: { [browserId]: [page, { ...page }] }, openFilesByWorktree: { [WORKTREE_ID]: [file, { ...file }] } } satisfies Partial<WorkspaceSessionState> & { activeBrowserTabId: string; activeFileId: string; activeTabType: 'browser' }
    const commitProjection = (session: WorkspaceSessionState): WorkspaceSessionState => ({
      ...session,
      ...projection
    })
    const { runtime, handle } = createDormantRuntimeTerminal({ commitProjection })
    runtime.setPtyController({ kill: vi.fn(), stopAndWait: vi.fn(async () => true) } as never)
    attachCloseNotifier(runtime, vi.fn())
    const published: object[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => published.push(structuredClone(snapshot)))

    await runtime.closeTerminal(handle, 'tab')
    const first = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const second = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)

    // prettier-ignore
    expect(first).toMatchObject({ worktree: WORKTREE_ID, activeTabId: browserId, activeTabType: 'browser', tabs: [{ type: 'file', id: fileId, filePath: fileId, relativePath: file.relativePath, language: file.language, isActive: false }, { type: 'browser', id: browserId, title: page.title, browserWorkspaceId: browserId, browserPageId: null, url: page.url, loading: page.loading, canGoBack: page.canGoBack, canGoForward: page.canGoForward, isActive: true }] })
    expect(first.tabs).toHaveLength(2)
    expect(second).toEqual(first)
    expect(published.at(-1)).toEqual(first)
  })

  it('preserves a renderer-adopted dormant tab at the store pre-commit boundary', async () => {
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    let runtime!: OrcaRuntimeService
    const fixture = createDormantRuntimeTerminal({
      beforeCommit: () => runtime.syncWindowGraph(0, rendererGraph('pty-1', 'Adopted', 9))
    })
    ;({ runtime } = fixture)
    const { handle, getSession } = fixture
    runtime.setPtyController({ kill, stopAndWait: vi.fn(async () => true) } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expectPartialDormantClose(runtime.closeTerminal(handle, 'tab'), handle)
    expect(kill).not.toHaveBeenCalled()
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('preserves a same-tab replacement binding installed during stop', async () => {
    const stop = deferredStop()
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession, setSession } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill: vi.fn(), stopAndWait: stop.stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    const closing = runtime.closeTerminal(handle, 'tab')
    await vi.waitFor(() => expect(stop.stopAndWait).toHaveBeenCalledOnce())
    const current = getSession()
    setSession({
      ...current,
      tabsByWorktree: {
        ...current.tabsByWorktree,
        [WORKTREE_ID]: current.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({
          ...tab,
          ptyId: 'pty-replacement',
          title: 'Replacement Terminal'
        }))
      },
      terminalLayoutsByTabId: {
        ...current.terminalLayoutsByTabId,
        [TAB_ID]: {
          ...current.terminalLayoutsByTabId[TAB_ID]!,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-replacement' }
        }
      }
    })
    stop.resolve(true)

    await expectPartialDormantClose(closing, handle)
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[WORKTREE_ID]?.[0]).toMatchObject({
      id: TAB_ID,
      ptyId: 'pty-replacement',
      title: 'Replacement Terminal'
    })
  })

  it('reports partial close when the renderer graph epoch drifts during stop', async () => {
    const stop = deferredStop()
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill: vi.fn(), stopAndWait: stop.stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    const closing = runtime.closeTerminal(handle, 'tab')
    await vi.waitFor(() => expect(stop.stopAndWait).toHaveBeenCalledOnce())
    runtime.markRendererReloading(0)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    stop.resolve(true)

    await expectPartialDormantClose(closing, handle)
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('reports partial close when the stopped PTY record is replaced during stop', async () => {
    const stop = deferredStop()
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill: vi.fn(), stopAndWait: stop.stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const internals = runtime as unknown as {
      ptysById: Map<string, object>
    }

    const closing = runtime.closeTerminal(handle, 'tab')
    await vi.waitFor(() => expect(stop.stopAndWait).toHaveBeenCalledOnce())
    internals.ptysById.set('pty-1', { ...internals.ptysById.get('pty-1')! })
    stop.resolve(true)

    await expectPartialDormantClose(closing, handle)
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it.each(['noop', 'throw', 'reappear'] as const)(
    'retries after a %s durable transaction without stopping the confirmed PTY twice',
    async (setter) => {
      const stopAndWait = vi.fn(async () => true)
      const closeTerminal = vi.fn()
      const { runtime, handle, setPersistenceBehavior } = createDormantRuntimeTerminal({ setter })
      runtime.setPtyController({ kill: vi.fn(), stopAndWait } as never)
      attachCloseNotifier(runtime, closeTerminal)

      await expectPartialDormantClose(runtime.closeTerminal(handle, 'tab'), handle)
      setPersistenceBehavior(undefined)
      await expect(runtime.closeTerminal(handle, 'tab')).resolves.toMatchObject({
        handle,
        ptyKilled: true,
        tabCloseRequested: true
      })
      expect(stopAndWait).toHaveBeenCalledOnce()
    }
  )

  it('retries after graph-epoch drift without stopping the confirmed PTY twice', async () => {
    const stop = deferredStop()
    const closeTerminal = vi.fn()
    const { runtime, handle } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill: vi.fn(), stopAndWait: stop.stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    const closing = runtime.closeTerminal(handle, 'tab')
    await vi.waitFor(() => expect(stop.stopAndWait).toHaveBeenCalledOnce())
    runtime.markRendererReloading(0)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    stop.resolve(true)
    await expectPartialDormantClose(closing, handle)

    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toMatchObject({ ptyKilled: true })
    expect(stop.stopAndWait).toHaveBeenCalledOnce()
  })

  it('retries after durable identity drift without stopping the confirmed PTY twice', async () => {
    const stop = deferredStop()
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession, setSession } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill: vi.fn(), stopAndWait: stop.stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    const session = getSession()
    const closing = runtime.closeTerminal(handle, 'tab')
    await vi.waitFor(() => expect(stop.stopAndWait).toHaveBeenCalledOnce())
    setSession({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [WORKTREE_ID]: session.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({
          ...tab,
          isPinned: true
        }))
      }
    })
    stop.resolve(true)
    await expectPartialDormantClose(closing, handle)

    setSession(session)
    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toMatchObject({ ptyKilled: true })
    expect(stop.stopAndWait).toHaveBeenCalledOnce()
  })

  it('invalidates a confirmed-stop tombstone when the same PTY record mutates', async () => {
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle, setPersistenceBehavior } = createDormantRuntimeTerminal({
      setter: 'throw'
    })
    runtime.setPtyController({ kill: vi.fn(), stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const internals = runtime as unknown as {
      ptysById: Map<string, { worktreeId: string }>
    }
    const record = internals.ptysById.get('pty-1')!

    await expectPartialDormantClose(runtime.closeTerminal(handle, 'tab'), handle)
    record.worktreeId = 'repo-2::/tmp/mutated'
    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_identity_ambiguous'
    )
    record.worktreeId = WORKTREE_ID
    setPersistenceBehavior(undefined)

    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toMatchObject({ ptyKilled: true })
    expect(stopAndWait).toHaveBeenCalledTimes(2)
  })

  it('invalidates a confirmed-stop tombstone when persisted createdAt changes', async () => {
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle, getSession, setSession, setPersistenceBehavior } =
      createDormantRuntimeTerminal({ setter: 'throw' })
    runtime.setPtyController({ kill: vi.fn(), stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const original = structuredClone(getSession())

    await expectPartialDormantClose(runtime.closeTerminal(handle, 'tab'), handle)
    const changed = structuredClone(original)
    changed.tabsByWorktree[WORKTREE_ID]![0]!.createdAt = 2
    setSession(changed)
    await expectPartialDormantClose(runtime.closeTerminal(handle, 'tab'), handle)
    setSession(original)
    setPersistenceBehavior(undefined)

    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toMatchObject({ ptyKilled: true })
    expect(stopAndWait).toHaveBeenCalledTimes(3)
  })

  it('does not transfer a confirmed-stop tombstone to a replacement PTY record', async () => {
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle, setPersistenceBehavior } = createDormantRuntimeTerminal({
      setter: 'throw'
    })
    runtime.setPtyController({ kill: vi.fn(), stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const internals = runtime as unknown as { ptysById: Map<string, object> }

    await expectPartialDormantClose(runtime.closeTerminal(handle, 'tab'), handle)
    internals.ptysById.set('pty-1', { ...internals.ptysById.get('pty-1')! })
    setPersistenceBehavior(undefined)

    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toMatchObject({ ptyKilled: true })
    expect(stopAndWait).toHaveBeenCalledTimes(2)
    expect(closeTerminal).toHaveBeenCalledWith(TAB_ID)
  })

  it('drops a failed-close stop tombstone when its disconnected PTY record is pruned', async () => {
    const { runtime, handle } = createDormantRuntimeTerminal({ setter: 'throw' })
    runtime.setPtyController({ kill: vi.fn(), stopAndWait: vi.fn(async () => true) } as never)
    attachCloseNotifier(runtime, vi.fn())
    const internals = runtime as unknown as {
      stoppedDormantTerminalByPtyId: Map<string, object>
      dropDisconnectedPtyRecord: (ptyId: string) => void
    }

    await expectPartialDormantClose(runtime.closeTerminal(handle, 'tab'), handle)
    expect(internals.stoppedDormantTerminalByPtyId.size).toBe(1)
    internals.dropDisconnectedPtyRecord('pty-1')
    expect(internals.stoppedDormantTerminalByPtyId.size).toBe(0)
  })

  it('reports unknown durability when the exact removal rollback is incomplete', async () => {
    const stopAndWait = vi.fn(async () => true)
    const closeTerminal = vi.fn()
    const { runtime, handle } = createDormantRuntimeTerminal({ setter: 'rollback-incomplete' })
    runtime.setPtyController({ kill: vi.fn(), stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expectPartialDormantClose(runtime.closeTerminal(handle, 'tab'), handle, 'unknown')
    expect(stopAndWait).toHaveBeenCalledOnce()
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it.each(['noop', 'throw', 'reappear'] as const)(
    'reports partial close when the durable removal transaction is %s',
    async (setter) => {
      const kill = vi.fn(() => true)
      const stopAndWait = vi.fn(async () => true)
      const closeTerminal = vi.fn()
      const { runtime, handle, getSession } = createDormantRuntimeTerminal({ setter })
      runtime.setPtyController({ kill, stopAndWait } as never)
      attachCloseNotifier(runtime, closeTerminal)

      await expectPartialDormantClose(runtime.closeTerminal(handle, 'tab'), handle)
      expect(stopAndWait).toHaveBeenCalledOnce()
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    }
  )

  it.each(['pinned', 'worktree', 'leaf'] as const)(
    'preserves dormant session state when the exact %s identity drifts during stop',
    async (drift) => {
      const stop = deferredStop()
      const closeTerminal = vi.fn()
      const { runtime, handle, getSession, setSession } = createDormantRuntimeTerminal()
      runtime.setPtyController({ kill: vi.fn(), stopAndWait: stop.stopAndWait } as never)
      attachCloseNotifier(runtime, closeTerminal)

      const closing = runtime.closeTerminal(handle, 'tab')
      await vi.waitFor(() => expect(stop.stopAndWait).toHaveBeenCalledOnce())
      const current = getSession()
      const replacementLeafId = '44444444-4444-4444-8444-444444444444'
      setSession({
        ...current,
        tabsByWorktree: {
          ...current.tabsByWorktree,
          [WORKTREE_ID]: current.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({
            ...tab,
            ...(drift === 'pinned' ? { isPinned: true } : {}),
            ...(drift === 'worktree' ? { worktreeId: 'repo-2::/tmp/replacement' } : {})
          }))
        },
        ...(drift === 'leaf'
          ? {
              terminalLayoutsByTabId: {
                ...current.terminalLayoutsByTabId,
                [TAB_ID]: {
                  root: { type: 'leaf' as const, leafId: replacementLeafId },
                  activeLeafId: replacementLeafId,
                  expandedLeafId: null,
                  ptyIdsByLeafId: { [replacementLeafId]: 'pty-1' }
                }
              }
            }
          : {})
      })
      stop.resolve(true)

      await expectPartialDormantClose(closing, handle)
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    }
  )

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

  it('does not tombstone a PTY when stop confirmation fails', async () => {
    const stopAndWait = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const closeTerminal = vi.fn()
    const { runtime, handle } = createDormantRuntimeTerminal()
    runtime.setPtyController({ kill: vi.fn(), stopAndWait } as never)
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_close_unavailable'
    )
    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toMatchObject({ ptyKilled: true })
    expect(stopAndWait).toHaveBeenCalledTimes(2)
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
