import type { Project, TerminalPaneLayoutNode, TerminalTab } from '../../shared/types'
import {
  firstTerminalLeafId,
  herdrExternalRefKey,
  herdrPaneRef,
  herdrSessionNameForProject,
  herdrSplitDirection,
  herdrTabRef,
  herdrWorktreeRef
} from '../../shared/herdr-session-identity'
import {
  assertHerdrRuntimeCompatible,
  type HerdrHostTransport,
  type HerdrPane,
  type HerdrSessionSnapshot,
  type HerdrTab,
  type HerdrWorkspace,
  type HerdrTerminalController,
  type HerdrTerminalControlOptions,
  unwrapHerdrResponse
} from './herdr-runtime-contract'
import {
  externalRefKey,
  indexHerdrSnapshot,
  takeUniqueMatch,
  type HerdrReconcileIndex
} from './herdr-reconcile-index'
import { HerdrSessionWatcher } from './herdr-session-watcher'
import type { HerdrProjectHostGraph } from './herdr-runtime-graph'
export type { HerdrProjectHostGraph } from './herdr-runtime-graph'
import type { HerdrWorktreeDescriptor } from './herdr-worktree-descriptor'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { bindCreatedHerdrRoots } from './herdr-created-root-bindings'
import { ensureExistingHerdrTabRoot } from './herdr-existing-tab-root'
export type { HerdrWorktreeDescriptor } from './herdr-worktree-descriptor'

export class HerdrRuntimeManager {
  private readonly panesBySessionAndExternalRef = new Map<string, string>()
  private readonly reconcileQueues = new Map<string, Promise<void>>()
  private readonly watcher: HerdrSessionWatcher

  constructor(private readonly transport: HerdrHostTransport) {
    this.watcher = new HerdrSessionWatcher(
      (sessionName, afterSequence) =>
        this.transport.subscribeEvents?.(sessionName, afterSequence) ?? null,
      (sessionName) => this.snapshot(sessionName),
      (sessionName, snapshot) => this.rememberPaneBindings(sessionName, snapshot)
    )
  }

  getPaneId(sessionName: string, projectId: string, leafId: string): string | null {
    const externalRef = herdrPaneRef(projectId, leafId)
    return (
      this.panesBySessionAndExternalRef.get(
        `${sessionName}\0${herdrExternalRefKey(externalRef)}`
      ) ?? null
    )
  }

  async reconcileProjectHost(graph: HerdrProjectHostGraph): Promise<HerdrSessionSnapshot> {
    const sessionName = herdrSessionNameForProject(graph.project)
    return runKeyedSerializedOperation(this.reconcileQueues, sessionName, async () => {
      await this.transport.ensureSession(sessionName)
      let snapshot = await this.snapshot(sessionName)
      this.watcher.watch(sessionName, snapshot.graph_revision)
      const index = indexHerdrSnapshot(snapshot)

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
          if (!layout?.root) {
            continue
          }
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
    })
  }

  dispose(): void {
    this.watcher.dispose()
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
    const bindingKey = `${sessionName}\0${herdrExternalRefKey(externalRef)}`
    let paneId = this.panesBySessionAndExternalRef.get(bindingKey)
    if (!paneId) {
      await this.transport.ensureSession(sessionName)
      const snapshot = await this.snapshot(sessionName)
      this.rememberPaneBindings(sessionName, snapshot)
      paneId = this.panesBySessionAndExternalRef.get(bindingKey)
    }
    if (!paneId) {
      throw new Error(`Herdr pane is not reconciled: ${externalRef.id}`)
    }
    return this.transport.controlTerminal(sessionName, paneId, options)
  }

  private rememberPaneBindings(sessionName: string, snapshot: HerdrSessionSnapshot): void {
    const prefix = `${sessionName}\0`
    for (const key of this.panesBySessionAndExternalRef.keys()) {
      if (key.startsWith(prefix)) {
        this.panesBySessionAndExternalRef.delete(key)
      }
    }
    for (const pane of snapshot.panes) {
      if (pane.external_ref?.owner !== 'orca') {
        continue
      }
      this.panesBySessionAndExternalRef.set(
        `${sessionName}\0${herdrExternalRefKey(pane.external_ref)}`,
        pane.pane_id
      )
    }
  }

  private async snapshot(sessionName: string): Promise<HerdrSessionSnapshot> {
    const result = unwrapHerdrResponse<{ snapshot: HerdrSessionSnapshot }>(
      await this.transport.request(sessionName, 'session.snapshot', {})
    )
    assertHerdrRuntimeCompatible({
      protocol: result.snapshot.protocol,
      ...result.snapshot.capabilities
    })
    return result.snapshot
  }

  private async ensureWorkspace(
    sessionName: string,
    projectId: string,
    worktree: HerdrWorktreeDescriptor,
    firstTab: TerminalTab | undefined,
    firstRoot: TerminalPaneLayoutNode | null,
    index: HerdrReconcileIndex
  ): Promise<HerdrWorkspace> {
    const externalRef = herdrWorktreeRef(projectId, worktree)
    const existing = index.workspaces.get(externalRefKey(externalRef))
    if (existing) {
      return existing
    }
    const adoptable = takeUniqueMatch(
      index.unclaimedWorkspaces,
      (workspace) => workspace.worktree?.checkout_path === worktree.path
    )
    if (adoptable) {
      const bound = unwrapHerdrResponse<{ workspace: HerdrWorkspace }>(
        await this.transport.request(sessionName, 'workspace.bind', {
          workspace_id: adoptable.workspace_id,
          external_ref: externalRef
        })
      ).workspace
      index.workspaces.set(externalRefKey(externalRef), bound)
      return bound
    }
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
    index.workspaces.set(externalRefKey(externalRef), result.workspace)
    await bindCreatedHerdrRoots(
      this.transport,
      sessionName,
      projectId,
      firstTab,
      firstLeafId,
      result,
      index
    )
    return result.workspace
  }

  private async ensureTabLayout(
    sessionName: string,
    projectId: string,
    workspaceId: string,
    tab: TerminalTab,
    root: TerminalPaneLayoutNode,
    index: HerdrReconcileIndex
  ): Promise<void> {
    const tabExternalRef = herdrTabRef(projectId, tab.id)
    const rootLeafId = firstTerminalLeafId(root)
    if (!rootLeafId) {
      return
    }
    const rootPaneExternalRef = herdrPaneRef(projectId, rootLeafId)
    let herdrTab = index.tabs.get(externalRefKey(tabExternalRef))
    let rootPane = index.panes.get(externalRefKey(rootPaneExternalRef))

    if (!herdrTab) {
      const expectedLabel = tab.customTitle ?? tab.title
      const adoptableTab = takeUniqueMatch(
        index.unclaimedTabs,
        (candidate) => candidate.workspace_id === workspaceId && candidate.label === expectedLabel
      )
      if (adoptableTab) {
        herdrTab = unwrapHerdrResponse<{ tab: HerdrTab }>(
          await this.transport.request(sessionName, 'tab.bind', {
            tab_id: adoptableTab.tab_id,
            external_ref: tabExternalRef
          })
        ).tab
        index.tabs.set(externalRefKey(tabExternalRef), herdrTab)
      }
    }

    if (herdrTab && !rootPane) {
      rootPane = await ensureExistingHerdrTabRoot(
        this.transport,
        sessionName,
        herdrTab,
        rootPaneExternalRef,
        index
      )
    }

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
      index.tabs.set(externalRefKey(tabExternalRef), created.tab)
      index.panes.set(externalRefKey(rootPaneExternalRef), created.root_pane)
    }
    if (!rootPane) {
      return
    }
    await this.ensureSplits(sessionName, projectId, root, rootPane.pane_id, index)
  }

  private async ensureSplits(
    sessionName: string,
    projectId: string,
    node: TerminalPaneLayoutNode,
    firstPaneId: string,
    index: HerdrReconcileIndex
  ): Promise<void> {
    if (node.type === 'leaf') {
      return
    }
    const secondLeafId = firstTerminalLeafId(node.second)
    if (!secondLeafId) {
      return
    }
    const secondRef = herdrPaneRef(projectId, secondLeafId)
    let secondPane = index.panes.get(externalRefKey(secondRef))
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
      index.panes.set(externalRefKey(secondRef), secondPane)
    }
    await this.ensureSplits(sessionName, projectId, node.first, firstPaneId, index)
    await this.ensureSplits(sessionName, projectId, node.second, secondPane.pane_id, index)
  }
}
