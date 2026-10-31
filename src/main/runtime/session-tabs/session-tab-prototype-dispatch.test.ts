import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { OrcaRuntimeService } from '../orca-runtime'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'

function snapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'folder:constructor-test',
    publicationEpoch: 'headless:before',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: 'tab::leaf',
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group', activeTabId: 'tab', tabOrder: ['tab'] }],
    tabs: [
      {
        type: 'terminal',
        id: 'tab::leaf',
        title: 'Terminal',
        parentTabId: 'tab',
        leafId: 'leaf',
        isActive: true
      }
    ]
  }
}

class SessionTabRuntime extends OrcaRuntimeService {
  move(
    model: RuntimeMobileSessionTabsSnapshot,
    move: RuntimeMobileSessionTabMove
  ): RuntimeMobileSessionTabMoveResult {
    return this.moveHeadlessMobileSessionTab(model.worktree, model, move)
  }

  seed(model: RuntimeMobileSessionTabsSnapshot): void {
    this.storeMobileSessionSnapshot(model.worktree, model)
  }

  applyProps(worktreeId: string, tabId: string): void {
    this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, tabId, { title: 'Updated' })
  }

  readSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined {
    return this.mobileSessionTabsByWorktree.get(worktreeId)
  }

  wait(signal?: AbortSignal): Promise<void> {
    return this.waitForSessionTabsInventoryPublication(signal)
  }

  resolveHostTabMethod() {
    return this.resolveMobileSessionHostTabId
  }

  normalizeOrderMethod() {
    return this.normalizeMobileSessionTabOrder
  }
}

class GroupDispatchRuntime extends SessionTabRuntime {
  readonly calls: string[] = []

  protected override splitHeadlessMobileSessionTabGroup(): RuntimeMobileSessionTabMoveResult {
    this.calls.push('split')
    return { moved: true }
  }

  protected override moveHeadlessMobileSessionTabToGroup(): RuntimeMobileSessionTabMoveResult {
    this.calls.push('move-to-group')
    return { moved: true }
  }

  protected override requireHeadlessTargetGroup(
    model: RuntimeMobileSessionTabsSnapshot,
    groupId: string
  ): RuntimeMobileSessionTabGroup {
    this.calls.push('require-group')
    return super.requireHeadlessTargetGroup(model, groupId)
  }

  protected override persistHeadlessTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode | null | undefined
  ): void {
    this.calls.push('persist-groups')
    super.persistHeadlessTabGroups(worktreeId, groups, layout)
  }
}

describe('original session tab runtime prototypes', () => {
  it.each(['split', 'move-to-group'] as const)('uses the runtime %s override', (kind) => {
    const runtime = new GroupDispatchRuntime(null)
    const move: RuntimeMobileSessionTabMove =
      kind === 'split'
        ? { kind, tabId: 'tab', targetGroupId: 'group', splitDirection: 'right' }
        : { kind, tabId: 'tab', targetGroupId: 'group' }
    expect(runtime.move(snapshot(), move)).toEqual({ moved: true })
    expect(runtime.calls).toEqual([kind])
  })

  it('uses both protected runtime group validation and persistence hooks', () => {
    const runtime = new GroupDispatchRuntime(null)
    expect(
      runtime.move(snapshot(), {
        kind: 'reorder',
        tabId: 'tab',
        targetGroupId: 'group',
        tabOrder: ['tab']
      })
    ).toEqual({ moved: true })
    expect(runtime.calls).toEqual(['require-group', 'persist-groups'])
  })

  it('uses the runtime top-level tab ID override while applying properties', () => {
    class TopLevelRuntime extends SessionTabRuntime {
      protected override getMobileSessionTopLevelTabId(
        tab: RuntimeMobileSessionSnapshotTab
      ): string {
        return `override:${super.getMobileSessionTopLevelTabId(tab)}`
      }
    }
    const runtime = new TopLevelRuntime(null)
    const model = snapshot()
    runtime.seed(model)
    runtime.applyProps(model.worktree, 'override:tab')
    expect(runtime.readSnapshot(model.worktree)?.tabs[0].title).toBe('Updated')
  })

  it('uses the runtime epoch override before registering a publication waiter', async () => {
    class EpochRuntime extends SessionTabRuntime {
      protected override getAuthoritativeSessionTabsInventoryEpoch(): number {
        return 7
      }
    }
    const runtime = new EpochRuntime(null)
    const controller = new AbortController()
    const waiting = runtime.wait(controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
  })

  it.each(['split', 'move-to-group', 'reorder'] as const)(
    'captures the runtime resolver before reading %s tabId',
    (kind) => {
      const runtime = new SessionTabRuntime(null)
      const original = runtime.resolveHostTabMethod()
      const trace: string[] = []
      Object.defineProperty(runtime, 'resolveMobileSessionHostTabId', {
        configurable: true,
        get() {
          trace.push('callee')
          return function (
            this: SessionTabRuntime,
            model: RuntimeMobileSessionTabsSnapshot | undefined,
            tabId: string
          ) {
            trace.push('call')
            expect(this).toBe(runtime)
            return original.call(this, model, tabId)
          }
        }
      })
      const tabId = {
        get tabId() {
          trace.push('tabId')
          return 'tab'
        }
      }
      const move: RuntimeMobileSessionTabMove =
        kind === 'split'
          ? {
              kind,
              get tabId() {
                return tabId.tabId
              },
              targetGroupId: 'group',
              splitDirection: 'right'
            }
          : kind === 'move-to-group'
            ? {
                kind,
                get tabId() {
                  return tabId.tabId
                },
                targetGroupId: 'group'
              }
            : {
                kind,
                get tabId() {
                  return tabId.tabId
                },
                targetGroupId: 'group',
                tabOrder: ['tab']
              }
      expect(runtime.move(snapshot(), move)).toEqual({ moved: true })
      expect(trace.slice(0, 3)).toEqual(['callee', 'tabId', 'call'])
    }
  )

  it('captures the runtime normalizer before reading tabOrder', () => {
    const runtime = new SessionTabRuntime(null)
    const original = runtime.normalizeOrderMethod()
    const trace: string[] = []
    Object.defineProperty(runtime, 'normalizeMobileSessionTabOrder', {
      configurable: true,
      get() {
        trace.push('callee')
        return function (
          this: SessionTabRuntime,
          model: RuntimeMobileSessionTabsSnapshot | undefined,
          group: RuntimeMobileSessionTabGroup,
          order: readonly string[]
        ) {
          trace.push('call')
          expect(this).toBe(runtime)
          return original.call(this, model, group, order)
        }
      }
    })
    expect(
      runtime.move(snapshot(), {
        kind: 'reorder',
        tabId: 'tab',
        targetGroupId: 'group',
        get tabOrder() {
          trace.push('tabOrder')
          return ['tab']
        }
      })
    ).toEqual({ moved: true })
    expect(trace).toEqual(['callee', 'tabOrder', 'call'])
  })
})

class SessionRuntime extends OrcaRuntimeService {
  readonly refreshArgumentCounts: number[] = []
  readonly reloadRequests: number[] = []
  restoreRequests = 0
  restoreResult = Promise.resolve()

  override async resolveGitWorktreeSelector(): Promise<ResolvedWorktree> {
    const git = {
      path: 'workspace',
      head: '',
      branch: 'selected',
      isBare: false,
      isMainWorktree: false
    }
    return {
      ...git,
      git,
      id: 'workspace',
      repoId: 'repo',
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    }
  }

  protected override refreshMobileSessionPtyRecords(
    ...args: Parameters<OrcaRuntimeService['refreshMobileSessionPtyRecords']>
  ): Promise<Set<string> | null> {
    this.refreshArgumentCounts.push(args.length)
    return Promise.resolve(null)
  }

  public override hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string> {
    return new Set()
  }

  protected override restoreLivePairedRendererSessionOwnedMobileTerminals(): void {}

  protected override beginGraphReload(windowId: number): number {
    this.reloadRequests.push(windowId)
    return 77
  }

  protected override hasPersistedStructuredAgentSessionStore(): boolean {
    return true
  }

  override prepareStructuredAgentSessionStartupRestoration(): Promise<void> {
    return Promise.resolve()
  }

  protected override restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    this.restoreRequests += 1
    return this.restoreResult
  }

  seedHeadlessSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void {
    this.mobileSessionTabsByWorktree.set(snapshot.worktree, snapshot)
  }

  setHostTabResolver(
    resolver: (snapshot: RuntimeMobileSessionTabsSnapshot, tabId: string) => string | null
  ): void {
    this.resolveMobileSessionHostTabId = resolver
  }

  restoreTabs(): Promise<void> {
    return this.restoreStructuredAgentSessionTabs()
  }

  closeTab(tab: RuntimeMobileSessionAgentTab): Promise<void> {
    return this.closeStructuredAgentSessionTab(tab, 'user-close')
  }
}

describe('session runtime reentry', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it('keeps omitted refresh arguments omitted after asynchronous workspace resolution', async () => {
    const runtime = new SessionRuntime()

    await runtime.listMobileSessionTabs('selected')

    expect(runtime.refreshArgumentCounts).toEqual([0])
  })

  it('uses public methods replaced after construction', async () => {
    const runtime = new SessionRuntime()
    const list = vi.spyOn(runtime, 'listAllMobileSessionTabsWithChangeSequence').mockResolvedValue({
      snapshots: [],
      changeSequence: 73
    })
    const project = vi
      .spyOn(runtime, 'projectStructuredAgentSessionTab')
      .mockImplementation(() => {})
    const input = {
      workspaceId: 'workspace',
      sessionId: 'session',
      agent: 'claude',
      activate: false
    } satisfies Parameters<OrcaRuntimeService['publishStructuredAgentSessionTab']>[0]

    await expect(runtime.listAllMobileSessionTabs('client')).resolves.toEqual([])
    await runtime.publishStructuredAgentSessionTab(input)

    expect(list).toHaveBeenCalledExactlyOnceWith('client')
    expect(project).toHaveBeenCalledExactlyOnceWith(input)
  })

  it('re-enters the protected graph reload override', () => {
    const runtime = new SessionRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    expect(runtime.markRendererReloading(1)).toEqual({ revision: 77, recovery: 'renderer' })
    expect(runtime.reloadRequests).toEqual([1])
  })

  it('shares the protected asynchronous restoration operation', async () => {
    const runtime = new SessionRuntime()
    const gate = Promise.withResolvers<void>()
    runtime.restoreResult = gate.promise

    const first = runtime.restoreTabs()
    const second = runtime.restoreTabs()

    expect(first).toBe(second)
    expect(runtime.restoreRequests).toBe(1)
    gate.resolve()
    await first
  })

  it('captures the headless callback before evaluating move arguments', async () => {
    const runtime = new SessionRuntime()
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: 'workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    runtime.seedHeadlessSnapshot(snapshot)
    const first = vi.fn(function (
      this: OrcaRuntimeService,
      received: RuntimeMobileSessionTabsSnapshot,
      tabId: string
    ) {
      expect(this).toBe(runtime)
      expect(received).toBe(snapshot)
      expect(tabId).toBe('tab')
      expect(arguments.length).toBe(2)
      return null
    })
    const replacement = vi.fn(function (
      this: OrcaRuntimeService,
      received: RuntimeMobileSessionTabsSnapshot,
      tabId: string
    ) {
      expect(this).toBe(runtime)
      expect(received).toBe(snapshot)
      expect(tabId).toBe('tab')
      return null
    })
    runtime.setHostTabResolver(first)

    await expect(
      runtime.moveMobileSessionTab('selected', {
        kind: 'reorder',
        get tabId() {
          runtime.setHostTabResolver(replacement)
          return 'tab'
        },
        targetGroupId: 'group',
        tabOrder: ['tab']
      })
    ).rejects.toThrow('tab_not_found')

    expect(first).toHaveBeenCalledExactlyOnceWith(snapshot, 'tab')
    expect(replacement).not.toHaveBeenCalled()
    await expect(
      runtime.moveMobileSessionTab('selected', {
        kind: 'reorder',
        tabId: 'tab',
        targetGroupId: 'group',
        tabOrder: ['tab']
      })
    ).rejects.toThrow('tab_not_found')
    expect(replacement).toHaveBeenCalledExactlyOnceWith(snapshot, 'tab')
  })

  it('captures the runtime callee before a tab getter replaces it', async () => {
    const runtime = new SessionRuntime()
    const first = vi.fn(function (this: OrcaRuntimeService, sessionId: string) {
      expect(this).toBe(runtime)
      expect(sessionId).toBe('session')
      return false
    })
    const replacement = vi.fn(() => false)
    runtime.retireStructuredAgentSessionTabFromSnapshot = first
    const tab: RuntimeMobileSessionAgentTab = {
      type: 'agent-session',
      id: 'agent-session:session',
      title: '',
      agent: 'claude',
      isActive: false,
      get sessionId() {
        runtime.retireStructuredAgentSessionTabFromSnapshot = replacement
        return 'session'
      }
    }

    await runtime.closeTab(tab)

    expect(first).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    await runtime.closeTab(tab)
    expect(replacement).toHaveBeenCalledExactlyOnceWith('session')
  })
})

class GraphRuntime extends OrcaRuntimeService {
  get graphTabs() {
    return this.tabs
  }
  get graphLeaves() {
    return this.leaves
  }
  get graphLeavesByPtyId() {
    return this.leavesByPtyId
  }
  get graphAvailability() {
    return this.graphStatus
  }
  get graphEpoch() {
    return this.rendererGraphEpoch
  }
  get detachedLeaves() {
    return this.detachedPreAllocatedLeaves
  }
  get syncCallbacks() {
    return this.graphSyncCallbacks
  }
}

const graph = {
  tabs: [{ tabId: 'tab', worktreeId: 'workspace', activeLeafId: 'leaf', layout: null, title: '' }],
  leaves: [
    {
      tabId: 'tab',
      worktreeId: 'workspace',
      leafId: 'leaf',
      paneRuntimeId: 1,
      ptyId: 'pty',
      paneTitle: null
    }
  ]
}

describe('runtime graph ownership', () => {
  it('shares detached preallocated leaves with terminal identity during renderer reload', async () => {
    const runtime = new GraphRuntime()
    const handle = runtime.preAllocateHandleForPty('pty')
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, graph)
    const leaf = runtime.graphLeaves.get('tab::leaf')

    runtime.markRendererReloading(1)

    expect(runtime.detachedLeaves.get('pty')).toBe(leaf)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.onPtyData('pty', 'after omitted leaf\n', 100)
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      tail: ['after omitted leaf']
    })
  })

  it('keeps the installed graph and its PTY index in one per-runtime authority', () => {
    const first = new GraphRuntime()
    const second = new GraphRuntime()
    first.attachWindow(1)
    first.syncWindowGraph(1, graph)
    const leaf = first.graphLeavesByPtyId.get('pty')?.[0]
    expect(leaf).toBe(first.graphLeaves.get('tab::leaf'))
    expect(first.graphLeavesByPtyId.has('pty')).toBe(true)
    expect(second.graphLeavesByPtyId.has('pty')).toBe(false)
    expect(second.graphAvailability).toBe('unavailable')

    first.markGraphUnavailable(1)
    expect(first.graphTabs.size).toBe(0)
    expect(first.graphLeaves.size).toBe(0)
    expect(first.graphLeavesByPtyId.has('pty')).toBe(false)
    expect(second.graphEpoch).toBe(0)
  })

  it('drains the captured callback list when a callback changes registration', () => {
    const runtime = new GraphRuntime()
    runtime.attachWindow(1)
    const later = vi.fn()
    const original = vi.fn()
    runtime.syncCallbacks.push(() => {
      runtime.syncCallbacks.splice(1, 1)
      runtime.syncCallbacks.push(later)
    }, original)

    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    expect(original).toHaveBeenCalledOnce()
    expect(later).not.toHaveBeenCalled()
  })
})
