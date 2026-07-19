import type {
  Project,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab,
  Worktree
} from '../../shared/types'
import {
  firstTerminalLeafId,
  herdrPaneRef,
  herdrSessionNameForProject,
  herdrSplitDirection,
  herdrTabRef,
  herdrWorktreeRef,
  type HerdrExternalRef
} from '../../shared/herdr-session-identity'
import {
  HERDR_PROTOCOL_VERSION,
  HerdrRuntimeError,
  type HerdrHostTransport,
  type HerdrEventSubscription,
  type HerdrPane,
  type HerdrSessionSnapshot,
  type HerdrTab,
  type HerdrWorkspace,
  type HerdrTerminalController,
  type HerdrTerminalControlOptions,
  unwrapHerdrResponse
} from './herdr-runtime-contract'

export type HerdrProjectHostGraph = {
  project: Project
  worktrees: HerdrWorktreeDescriptor[]
  tabsByWorktreeId: Record<string, TerminalTab[]>
  layoutsByTabId: Record<string, TerminalLayoutSnapshot>
}

export type HerdrWorktreeDescriptor = Pick<Worktree, 'id' | 'instanceId' | 'path' | 'displayName'>

type ReconcileIndex = {
  workspaces: Map<string, HerdrWorkspace>
  tabs: Map<string, HerdrTab>
  panes: Map<string, HerdrPane>
}

function indexSnapshot(snapshot: HerdrSessionSnapshot): ReconcileIndex {
  return {
    workspaces: new Map(
      snapshot.workspaces.flatMap((workspace) =>
        workspace.external_ref ? [[workspace.external_ref.id, workspace] as const] : []
      )
    ),
    tabs: new Map(
      snapshot.tabs.flatMap((tab) =>
        tab.external_ref ? [[tab.external_ref.id, tab] as const] : []
      )
    ),
    panes: new Map(
      snapshot.panes.flatMap((pane) =>
        pane.external_ref ? [[pane.external_ref.id, pane] as const] : []
      )
    )
  }
}

function externalRefId(ref: HerdrExternalRef): string {
  return ref.id
}

export class HerdrRuntimeManager {
  private readonly panesBySessionAndExternalRef = new Map<string, string>()
  private readonly eventSubscriptions = new Map<
    string,
    { cursor: number; subscription: HerdrEventSubscription }
  >()
  private readonly refreshes = new Map<string, Promise<void>>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(private readonly transport: HerdrHostTransport) {}

  getPaneId(sessionName: string, projectId: string, leafId: string): string | null {
    const externalRef = herdrPaneRef(projectId, leafId)
    return this.panesBySessionAndExternalRef.get(`${sessionName}\0${externalRef.id}`) ?? null
  }

  async reconcileProjectHost(graph: HerdrProjectHostGraph): Promise<HerdrSessionSnapshot> {
    const sessionName = herdrSessionNameForProject(graph.project)
    await this.transport.ensureSession(sessionName)
    let snapshot = await this.snapshot(sessionName)
    this.watchSession(sessionName, snapshot.graph_revision)
    const index = indexSnapshot(snapshot)

    for (const worktree of graph.worktrees) {
      const tabs = graph.tabsByWorktreeId[worktree.id] ?? []
      const firstTab = tabs.find((tab) => graph.layoutsByTabId[tab.id]?.root)
      const workspace = await this.ensureWorkspace(
        sessionName,
        graph.project.id,
        worktree,
        firstTab,
        firstTab ? (graph.layoutsByTabId[firstTab.id]?.root ?? null) : null,
        index
      )
      for (const tab of tabs) {
        const layout = graph.layoutsByTabId[tab.id]
        if (!layout?.root) continue
        await this.ensureTabLayout(
          sessionName,
          graph.project.id,
          workspace.workspace_id,
          tab,
          layout.root,
          index
        )
      }
    }

    snapshot = await this.snapshot(sessionName)
    this.rememberPaneBindings(sessionName, snapshot)
    return snapshot
  }

  dispose(): void {
    this.disposed = true
    for (const watcher of this.eventSubscriptions.values()) watcher.subscription.release()
    this.eventSubscriptions.clear()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
  }

  async controlProjectPane(
    project: Project,
    leafId: string,
    options: HerdrTerminalControlOptions
  ): Promise<HerdrTerminalController> {
    if (!this.transport.controlTerminal) {
      throw new Error('Herdr host transport does not support terminal control')
    }
    const sessionName = herdrSessionNameForProject(project)
    const externalRef = herdrPaneRef(project.id, leafId)
    let paneId = this.panesBySessionAndExternalRef.get(`${sessionName}\0${externalRef.id}`)
    if (!paneId) {
      await this.transport.ensureSession(sessionName)
      const snapshot = await this.snapshot(sessionName)
      this.rememberPaneBindings(sessionName, snapshot)
      paneId = this.panesBySessionAndExternalRef.get(`${sessionName}\0${externalRef.id}`)
    }
    if (!paneId) throw new Error(`Herdr pane is not reconciled: ${externalRef.id}`)
    return this.transport.controlTerminal(sessionName, paneId, options)
  }

  private rememberPaneBindings(sessionName: string, snapshot: HerdrSessionSnapshot): void {
    const prefix = `${sessionName}\0`
    for (const key of this.panesBySessionAndExternalRef.keys()) {
      if (key.startsWith(prefix)) this.panesBySessionAndExternalRef.delete(key)
    }
    for (const pane of snapshot.panes) {
      if (pane.external_ref?.owner !== 'orca') continue
      this.panesBySessionAndExternalRef.set(`${sessionName}\0${pane.external_ref.id}`, pane.pane_id)
    }
  }

  private watchSession(sessionName: string, afterSequence: number): void {
    if (
      this.disposed ||
      !this.transport.subscribeEvents ||
      this.eventSubscriptions.has(sessionName)
    ) {
      return
    }
    const subscription = this.transport.subscribeEvents(sessionName, afterSequence)
    const watcher = { cursor: afterSequence, subscription }
    this.eventSubscriptions.set(sessionName, watcher)
    subscription.onEvent((event) => {
      const current = this.eventSubscriptions.get(sessionName)
      if (current !== watcher || event.sequence <= current.cursor) return
      if (event.sequence !== current.cursor + 1) {
        this.restartWatchFromSnapshot(sessionName)
        return
      }
      current.cursor = event.sequence
      this.refreshSnapshot(sessionName)
    })
    subscription.onError((error: HerdrRuntimeError) => {
      if (this.eventSubscriptions.get(sessionName) !== watcher) return
      if (error.code === 'stale_cursor' || error.code === 'transport_error') {
        this.restartWatchFromSnapshot(sessionName)
      }
    })
  }

  private refreshSnapshot(sessionName: string): void {
    if (this.refreshes.has(sessionName)) return
    const refresh = this.snapshot(sessionName)
      .then((snapshot) => this.rememberPaneBindings(sessionName, snapshot))
      .catch(() => this.restartWatchFromSnapshot(sessionName))
      .finally(() => this.refreshes.delete(sessionName))
    this.refreshes.set(sessionName, refresh)
  }

  private restartWatchFromSnapshot(sessionName: string): void {
    if (this.disposed) return
    const current = this.eventSubscriptions.get(sessionName)
    current?.subscription.release()
    this.eventSubscriptions.delete(sessionName)
    void this.snapshot(sessionName)
      .then((snapshot) => {
        this.rememberPaneBindings(sessionName, snapshot)
        this.watchSession(sessionName, snapshot.graph_revision)
      })
      .catch(() => {
        if (this.disposed || this.retryTimers.has(sessionName)) return
        const timer = setTimeout(() => {
          this.retryTimers.delete(sessionName)
          this.restartWatchFromSnapshot(sessionName)
        }, 1_000)
        this.retryTimers.set(sessionName, timer)
      })
  }

  private async snapshot(sessionName: string): Promise<HerdrSessionSnapshot> {
    const result = unwrapHerdrResponse<{ snapshot: HerdrSessionSnapshot }>(
      await this.transport.request(sessionName, 'session.snapshot', {})
    )
    if (result.snapshot.protocol !== HERDR_PROTOCOL_VERSION) {
      throw new HerdrRuntimeError(
        'protocol_mismatch',
        `Orca requires Herdr protocol ${HERDR_PROTOCOL_VERSION}, received ${result.snapshot.protocol}`
      )
    }
    return result.snapshot
  }

  private async ensureWorkspace(
    sessionName: string,
    projectId: string,
    worktree: HerdrWorktreeDescriptor,
    firstTab: TerminalTab | undefined,
    firstRoot: TerminalPaneLayoutNode | null,
    index: ReconcileIndex
  ): Promise<HerdrWorkspace> {
    const externalRef = herdrWorktreeRef(projectId, worktree)
    const existing = index.workspaces.get(externalRefId(externalRef))
    if (existing) return existing
    const firstLeafId = firstTerminalLeafId(firstRoot)
    const result = unwrapHerdrResponse<{
      workspace: HerdrWorkspace
      tab: HerdrTab
      root_pane: HerdrPane
    }>(
      await this.transport.request(sessionName, 'workspace.create', {
        cwd: worktree.path,
        label: worktree.displayName,
        focus: false,
        external_ref: externalRef,
        root_tab_external_ref: firstTab ? herdrTabRef(projectId, firstTab.id) : undefined,
        root_pane_external_ref: firstLeafId ? herdrPaneRef(projectId, firstLeafId) : undefined
      })
    )
    index.workspaces.set(externalRefId(externalRef), result.workspace)
    if (result.tab.external_ref) index.tabs.set(result.tab.external_ref.id, result.tab)
    if (result.root_pane.external_ref) {
      index.panes.set(result.root_pane.external_ref.id, result.root_pane)
    }
    return result.workspace
  }

  private async ensureTabLayout(
    sessionName: string,
    projectId: string,
    workspaceId: string,
    tab: TerminalTab,
    root: TerminalPaneLayoutNode,
    index: ReconcileIndex
  ): Promise<void> {
    const tabExternalRef = herdrTabRef(projectId, tab.id)
    const rootLeafId = firstTerminalLeafId(root)
    if (!rootLeafId) return
    const rootPaneExternalRef = herdrPaneRef(projectId, rootLeafId)
    let herdrTab = index.tabs.get(externalRefId(tabExternalRef))
    let rootPane = index.panes.get(externalRefId(rootPaneExternalRef))

    if (!herdrTab) {
      const created = unwrapHerdrResponse<{ tab: HerdrTab; root_pane: HerdrPane }>(
        await this.transport.request(sessionName, 'tab.create', {
          workspace_id: workspaceId,
          cwd: tab.startupCwd,
          label: tab.customTitle ?? tab.title,
          focus: false,
          external_ref: tabExternalRef,
          root_pane_external_ref: rootPaneExternalRef
        })
      )
      herdrTab = created.tab
      rootPane = created.root_pane
      index.tabs.set(externalRefId(tabExternalRef), created.tab)
      index.panes.set(externalRefId(rootPaneExternalRef), created.root_pane)
    }
    if (!rootPane) return
    await this.ensureSplits(sessionName, projectId, root, rootPane.pane_id, index)
  }

  private async ensureSplits(
    sessionName: string,
    projectId: string,
    node: TerminalPaneLayoutNode,
    firstPaneId: string,
    index: ReconcileIndex
  ): Promise<void> {
    if (node.type === 'leaf') return
    const secondLeafId = firstTerminalLeafId(node.second)
    if (!secondLeafId) return
    const secondRef = herdrPaneRef(projectId, secondLeafId)
    let secondPane = index.panes.get(externalRefId(secondRef))
    if (!secondPane) {
      const result = unwrapHerdrResponse<{ pane: HerdrPane }>(
        await this.transport.request(sessionName, 'pane.split', {
          target_pane_id: firstPaneId,
          direction: herdrSplitDirection(node.direction),
          ratio: node.ratio ?? 0.5,
          focus: false,
          external_ref: secondRef
        })
      )
      secondPane = result.pane
      index.panes.set(externalRefId(secondRef), secondPane)
    }
    await this.ensureSplits(sessionName, projectId, node.first, firstPaneId, index)
    await this.ensureSplits(sessionName, projectId, node.second, secondPane.pane_id, index)
  }
}
