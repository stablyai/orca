import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeRendererSyncWindowGraph,
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeSyncWindowGraphResult
} from '../../shared/runtime-session-contracts'

export const NATIVE_DESKTOP_GRAPH_ID = -1

type WindowGraph = {
  graph: RuntimeRendererSyncWindowGraph
  snapshots: Map<string, RuntimeMobileSessionTabsSnapshot>
}

type GraphRuntime = Pick<
  OrcaRuntimeService,
  'attachWindow' | 'syncWindowGraph' | 'markGraphUnavailable'
>

export class NativeDesktopWindowGraphs {
  private readonly windows = new Map<number, WindowGraph>()
  private epoch = randomUUID()
  private version = 0
  private readonly membershipVersions = new Map<number, symbol>()

  constructor(private readonly runtime: GraphRuntime) {}

  sync(windowId: number, graph: RuntimeRendererSyncWindowGraph): RuntimeSyncWindowGraphResult {
    if (new Set(graph.tabs.map((tab) => tab.tabId)).size !== graph.tabs.length) {
      throw new Error('duplicate_runtime_tab_id')
    }
    for (const [id, entry] of this.windows) {
      if (id === windowId) {
        continue
      }
      const homes = new Map(entry.graph.tabs.map((tab) => [tab.tabId, tab.worktreeId]))
      if (
        graph.tabs.some((tab) => homes.has(tab.tabId) && homes.get(tab.tabId) !== tab.worktreeId)
      ) {
        throw new Error('duplicate_runtime_tab_id')
      }
    }
    this.membershipVersions.set(windowId, Symbol())
    const previous = this.windows.get(windowId)
    const sameDocument = previous?.graph.rendererGeneration === graph.rendererGeneration
    if (!sameDocument) {
      this.epoch = randomUUID()
    }
    const snapshots = sameDocument
      ? previous.snapshots
      : new Map<string, RuntimeMobileSessionTabsSnapshot>()
    const retained = new Set([
      ...(graph.mobileSessionTabs ?? []).map((snapshot) => snapshot.worktree),
      ...(graph.unchangedMobileSessionWorktrees ?? [])
    ])
    for (const key of snapshots.keys()) {
      if (!retained.has(key)) {
        snapshots.delete(key)
      }
    }
    for (const snapshot of graph.mobileSessionTabs ?? []) {
      snapshots.set(snapshot.worktree, snapshot)
    }
    this.windows.delete(windowId)
    this.windows.set(windowId, { graph, snapshots })
    this.runtime.attachWindow(NATIVE_DESKTOP_GRAPH_ID)
    return this.publish()
  }

  remove(windowId: number): void {
    this.membershipVersions.delete(windowId)
    if (!this.windows.delete(windowId)) {
      return
    }
    if (this.windows.size === 0) {
      this.runtime.markGraphUnavailable(NATIVE_DESKTOP_GRAPH_ID)
    } else {
      this.epoch = randomUUID()
      this.publish()
    }
  }

  suspend(windowId: number): () => void {
    const previous = this.windows.get(windowId)
    this.remove(windowId)
    const version = Symbol()
    this.membershipVersions.set(windowId, version)
    return () => {
      if (
        !previous ||
        this.windows.has(windowId) ||
        this.membershipVersions.get(windowId) !== version
      ) {
        return
      }
      this.windows.set(windowId, previous)
      this.epoch = randomUUID()
      this.runtime.attachWindow(NATIVE_DESKTOP_GRAPH_ID)
      this.publish()
    }
  }

  windowIdsForTab(tabId: string): number[] {
    return [...this.windows]
      .filter(([, entry]) => entry.graph.tabs.some((tab) => tab.tabId === tabId))
      .map(([id]) => id)
      .toReversed()
  }

  private publish(): RuntimeSyncWindowGraphResult {
    const tabs = new Map<string, RuntimeSyncedTab>()
    const leaves = new Map<string, RuntimeSyncedLeaf>()
    const snapshots = new Map<string, RuntimeMobileSessionTabsSnapshot>()
    let latest: RuntimeRendererSyncWindowGraph = {
      tabs: [],
      leaves: [],
      rendererGeneration: this.epoch
    }
    const grids: NonNullable<RuntimeRendererSyncWindowGraph['terminalGroupGridSizes']> = {}
    const activeGroups: NonNullable<RuntimeRendererSyncWindowGraph['activeGroupByWorkspace']> = {}
    for (const entry of this.windows.values()) {
      latest = entry.graph
      for (const tab of entry.graph.tabs) {
        tabs.set(tab.tabId, tab)
      }
      for (const leaf of entry.graph.leaves) {
        leaves.set(`${leaf.tabId}:${leaf.leafId}`, leaf)
      }
      for (const [key, snapshot] of entry.snapshots) {
        const before = snapshots.get(key)
        const rows = new Map(before?.tabs.map((tab) => [tab.id, tab]))
        for (const tab of snapshot.tabs) {
          rows.set(tab.id, tab)
        }
        snapshots.set(key, { ...snapshot, tabs: [...rows.values()] })
      }
      Object.assign(grids, entry.graph.terminalGroupGridSizes)
      Object.assign(activeGroups, entry.graph.activeGroupByWorkspace)
    }
    this.version += 1
    return this.runtime.syncWindowGraph(NATIVE_DESKTOP_GRAPH_ID, {
      ...latest,
      rendererGeneration: this.epoch,
      tabs: [...tabs.values()],
      leaves: [...leaves.values()],
      terminalGroupGridSizes: grids,
      activeGroupByWorkspace: activeGroups,
      mobileSessionTabs: [...snapshots.values()].map((snapshot) => ({
        ...snapshot,
        publicationEpoch: this.epoch,
        snapshotVersion: this.version
      })),
      unchangedMobileSessionWorktrees: []
    })
  }
}

const graphsByRuntime = new WeakMap<GraphRuntime, NativeDesktopWindowGraphs>()

export function nativeDesktopWindowGraphs(runtime: GraphRuntime): NativeDesktopWindowGraphs {
  let graphs = graphsByRuntime.get(runtime)
  if (!graphs) {
    graphs = new NativeDesktopWindowGraphs(runtime)
    graphsByRuntime.set(runtime, graphs)
  }
  return graphs
}
