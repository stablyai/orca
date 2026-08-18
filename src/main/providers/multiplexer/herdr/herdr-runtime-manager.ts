import type { Project } from '../../../../shared/project-types'
import { herdrSessionNameForProject } from '../../../../shared/herdr-session-identity'
import type {
  HerdrHostTransport,
  HerdrSessionSnapshot,
  HerdrTerminalController,
  HerdrTerminalControlOptions
} from './herdr-runtime-contract'
import { HerdrRuntimeError, unwrapHerdrResponse } from './herdr-runtime-contract'
import {
  enrichHerdrWorkspaceCheckouts,
  ensureStockHerdrWorkspace,
  type HerdrProjectHostGraph
} from './ensure-herdr-workspace'
export type { HerdrProjectHostGraph, HerdrWorktreeDescriptor } from './ensure-herdr-workspace'
import { runKeyedSerializedOperation } from '../../../cli/keyed-promise-queue'
import {
  paneBindingMapKey,
  rememberOrcaPaneBindings,
  orcaPaneBinding,
  collectLeafIds
} from './herdr-binding-metadata'
import { ensureTabLayout } from './herdr-tab-layout'
import { materializeHerdrLeafPane } from './herdr-leaf-materialize'
import type { HerdrBindingAgentState } from './herdr-pty-binding-queries'
import {
  claimAndPresentHerdrSurfaces,
  collectHerdrSurfaceActions,
  collectUnboundHerdrSurfaces,
  resolveHerdrPaneIdentities,
  type HerdrImportedSurface,
  type HerdrOrcaSurfaceAction,
  type HerdrSurfacePresenter
} from './herdr-orca-surface-import'

export type HerdrAgentRollup = {
  agents: HerdrBindingAgentState[]
}

const RECONCILE_EVENT_DEBOUNCE_MS = 150

const RECONCILE_EVENT_KINDS = new Set([
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.closed',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.focused',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'tab.focused',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'layout.updated'
])

export type HerdrLivePaneListener = (sessionName: string, paneIds: ReadonlySet<string>) => void
export type HerdrPaneExitListener = (sessionName: string, paneId: string) => void

function herdrEventKind(event: string): string {
  return event.includes('.') ? event : event.replaceAll('_', '.')
}

function herdrEventPaneId(data: Record<string, unknown>): string | null {
  return typeof data.pane_id === 'string' ? data.pane_id : null
}

export type HerdrSurfaceSync = {
  persist: (surface: HerdrImportedSurface) => void
  present?: HerdrSurfacePresenter
  presentAction?: (action: HerdrOrcaSurfaceAction) => void
}

function graphKey(sessionName: string, projectId: string): string {
  return `${sessionName}\n${projectId}`
}

export class HerdrRuntimeManager {
  private readonly paneIdsBySessionAndBinding = new Map<string, string>()
  private readonly reconcileQueues = new Map<string, Promise<void>>()
  private readonly graphsByKey = new Map<string, HerdrProjectHostGraph>()
  private readonly eventRefreshTimers = new Map<string, NodeJS.Timeout>()
  private readonly lastSnapshots = new Map<string, HerdrSessionSnapshot>()
  private eventUnsubscribe: (() => void) | null = null

  constructor(
    private readonly transport: HerdrHostTransport,
    // Live store-backed shared session name; read per call because settings can change while the manager is cached.
    private readonly sharedName?: () => string | undefined,
    private readonly onLivePaneIds?: HerdrLivePaneListener,
    private readonly surfaceSync?: HerdrSurfaceSync,
    private readonly onPaneExited?: HerdrPaneExitListener
  ) {}

  private paneHintsForRoot(
    sessionName: string,
    projectId: string,
    root: Parameters<typeof collectLeafIds>[0]
  ): Record<string, string> {
    const hints: Record<string, string> = {}
    for (const leafId of collectLeafIds(root)) {
      const paneId = this.getPaneId(sessionName, projectId, leafId)
      if (paneId) {
        hints[leafId] = paneId
      }
    }
    return hints
  }

  getPaneId(sessionName: string, projectId: string, leafId: string): string | null {
    return (
      this.paneIdsBySessionAndBinding.get(
        paneBindingMapKey(sessionName, orcaPaneBinding(projectId, leafId))
      ) ?? null
    )
  }

  async reconcileProjectHost(graph: HerdrProjectHostGraph): Promise<HerdrSessionSnapshot> {
    const sessionName = herdrSessionNameForProject(graph.project, this.sharedName?.())
    return runKeyedSerializedOperation(this.reconcileQueues, sessionName, async () => {
      await this.transport.ensureSession(sessionName)
      this.graphsByKey.set(graphKey(sessionName, graph.project.id), graph)
      this.ensureEventSubscription()
      let snapshot = await this.snapshot(sessionName)
      await enrichHerdrWorkspaceCheckouts(this.transport, sessionName, snapshot)

      for (const worktree of graph.worktrees) {
        const tabs = graph.tabsByWorktreeId[worktree.id] ?? []
        const firstTab = tabs.find((tab) => graph.layoutsByTabId[tab.id]?.root)
        if (!firstTab) {
          continue
        }
        const workspace = await ensureStockHerdrWorkspace(
          this.transport,
          sessionName,
          graph.project.id,
          worktree,
          firstTab,
          firstTab ? (graph.layoutsByTabId[firstTab.id]?.root ?? null) : null,
          snapshot
        )
        for (const tab of tabs) {
          const root = graph.layoutsByTabId[tab.id]?.root
          if (root) {
            await ensureTabLayout(
              this.transport,
              sessionName,
              graph.project.id,
              workspace.workspace_id,
              tab,
              root,
              snapshot,
              {
                ...graph.persistedPaneIdsByLeafId,
                ...this.paneHintsForRoot(sessionName, graph.project.id, root)
              }
            )
          }
        }
      }

      rememberOrcaPaneBindings(
        this.paneIdsBySessionAndBinding,
        sessionName,
        graph.project.id,
        snapshot
      )
      snapshot = await this.snapshot(sessionName)
      rememberOrcaPaneBindings(
        this.paneIdsBySessionAndBinding,
        sessionName,
        graph.project.id,
        snapshot
      )
      this.publishLivePaneIds(sessionName, snapshot)
      await this.importUnboundSurfaces(sessionName, [graph], snapshot)
      this.lastSnapshots.set(sessionName, snapshot)
      return snapshot
    })
  }

  // Event-driven reconcile: on the socket transport, structural events refresh
  // the snapshot and re-resolve pane bindings without a full re-reconcile.
  private ensureEventSubscription(): void {
    if (this.eventUnsubscribe || !this.transport.onEvent) {
      return
    }
    this.eventUnsubscribe = this.transport.onEvent((event) => {
      const kind = herdrEventKind(event.event)
      const sessionNames = event.sessionName
        ? [event.sessionName]
        : [...this.graphsByKey.keys()].map((key) => key.slice(0, key.indexOf('\n')))
      if (kind === 'pane.exited') {
        const paneId = herdrEventPaneId(event.data)
        if (paneId) {
          for (const sessionName of sessionNames) {
            this.onPaneExited?.(sessionName, paneId)
          }
        }
      }
      if (!RECONCILE_EVENT_KINDS.has(kind) && !RECONCILE_EVENT_KINDS.has(event.event)) {
        return
      }
      for (const sessionName of sessionNames) {
        this.scheduleEventRefresh(sessionName)
      }
    })
  }

  private scheduleEventRefresh(sessionName: string): void {
    const existing = this.eventRefreshTimers.get(sessionName)
    if (existing) {
      clearTimeout(existing)
    }
    const timer = setTimeout(() => {
      this.eventRefreshTimers.delete(sessionName)
      void this.refreshFromEvent(sessionName).catch((error) => {
        console.error(
          `[herdr] Event reconcile for ${sessionName} failed:`,
          error instanceof Error ? error.message : error
        )
      })
    }, RECONCILE_EVENT_DEBOUNCE_MS)
    this.eventRefreshTimers.set(sessionName, timer)
  }

  private graphsForSession(sessionName: string): HerdrProjectHostGraph[] {
    const prefix = `${sessionName}\n`
    return [...this.graphsByKey.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, graph]) => graph)
  }

  private publishLivePaneIds(sessionName: string, snapshot: HerdrSessionSnapshot): void {
    this.onLivePaneIds?.(sessionName, new Set(snapshot.panes.map((pane) => pane.pane_id)))
  }

  private async refreshFromEvent(sessionName: string): Promise<void> {
    const graphs = this.graphsForSession(sessionName)
    if (graphs.length === 0) {
      return
    }
    await runKeyedSerializedOperation(this.reconcileQueues, sessionName, async () => {
      const snapshot = await this.snapshot(sessionName)
      for (const graph of graphs) {
        rememberOrcaPaneBindings(
          this.paneIdsBySessionAndBinding,
          sessionName,
          graph.project.id,
          snapshot
        )
      }
      this.publishLivePaneIds(sessionName, snapshot)
      await this.importUnboundSurfaces(sessionName, graphs, snapshot)
      this.applyHerdrSurfaceActions(sessionName, graphs, snapshot)
      this.lastSnapshots.set(sessionName, snapshot)
    })
  }

  private applyHerdrSurfaceActions(
    sessionName: string,
    graphs: HerdrProjectHostGraph[],
    snapshot: HerdrSessionSnapshot
  ): void {
    if (!this.surfaceSync?.presentAction) {
      this.lastSnapshots.set(sessionName, snapshot)
      return
    }
    const actions = collectHerdrSurfaceActions(
      this.lastSnapshots.get(sessionName) ?? null,
      snapshot,
      resolveHerdrPaneIdentities(sessionName, graphs, this.paneIdsBySessionAndBinding)
    )
    for (const action of actions) {
      this.surfaceSync.presentAction(action)
    }
  }

  private async importUnboundSurfaces(
    sessionName: string,
    graphs: HerdrProjectHostGraph[],
    snapshot: HerdrSessionSnapshot
  ): Promise<void> {
    if (!this.surfaceSync) {
      return
    }
    for (const graph of graphs) {
      const surfaces = collectUnboundHerdrSurfaces(
        sessionName,
        graph,
        snapshot,
        this.paneIdsBySessionAndBinding
      )
      if (surfaces.length === 0) {
        continue
      }
      await claimAndPresentHerdrSurfaces(
        this.transport,
        sessionName,
        graph.project.id,
        snapshot,
        surfaces,
        this.surfaceSync.persist,
        this.surfaceSync.present
      )
      rememberOrcaPaneBindings(
        this.paneIdsBySessionAndBinding,
        sessionName,
        graph.project.id,
        snapshot
      )
    }
  }

  dispose(): void {
    for (const timer of this.eventRefreshTimers.values()) {
      clearTimeout(timer)
    }
    this.eventRefreshTimers.clear()
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe()
      this.eventUnsubscribe = null
    }
    this.graphsByKey.clear()
    this.paneIdsBySessionAndBinding.clear()
    this.lastSnapshots.clear()
    void this.transport.disconnect?.()
  }

  async listAgents(sessionName: string): Promise<HerdrAgentRollup> {
    const response = unwrapHerdrResponse<{ agents: HerdrBindingAgentState[] }>(
      await this.transport.request(sessionName, 'agent.list', {})
    )
    return { agents: response.agents }
  }

  /** Session names this manager has reconciled, for per-session agent scans. */
  listSessionNames(): string[] {
    return [...new Set([...this.graphsByKey.keys()].map((key) => key.slice(0, key.indexOf('\n'))))]
  }

  async controlProjectPane(
    project: Project,
    leafId: string,
    options: HerdrTerminalControlOptions
  ): Promise<HerdrTerminalController> {
    if (!this.transport.controlTerminal) {
      throw new Error('Herdr host transport does not support terminal control')
    }
    const sessionName = herdrSessionNameForProject(project, this.sharedName?.())
    const binding = orcaPaneBinding(project.id, leafId)
    const paneId = this.paneIdsBySessionAndBinding.get(paneBindingMapKey(sessionName, binding))
    if (!paneId) {
      throw new HerdrRuntimeError(
        'herdr_binding_missing',
        `Herdr pane is not reconciled for Orca leaf ${leafId}`
      )
    }
    return this.transport.controlTerminal(sessionName, paneId, options)
  }

  // Why: a spawn whose leaf never reconciled to a pane must claim an existing
  // workspace pane instead of failing the whole tab.
  async materializeLeafPane(
    project: Project,
    leafId: string,
    cwd: string,
    worktree: { id: string; path: string; displayName?: string }
  ): Promise<string | null> {
    const sessionName = herdrSessionNameForProject(project, this.sharedName?.())
    const graph = this.graphsByKey.get(graphKey(sessionName, project.id))
    return materializeHerdrLeafPane({
      transport: this.transport,
      sessionName,
      project,
      leafId,
      cwd,
      worktree,
      graph,
      paneIdsBySessionAndBinding: this.paneIdsBySessionAndBinding,
      snapshot: () => this.snapshot(sessionName)
    })
  }

  private async snapshot(sessionName: string): Promise<HerdrSessionSnapshot> {
    return unwrapHerdrResponse<{ snapshot: HerdrSessionSnapshot }>(
      await this.transport.request(sessionName, 'session.snapshot', {})
    ).snapshot
  }
}
