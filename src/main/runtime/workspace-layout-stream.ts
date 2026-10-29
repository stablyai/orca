import type {
  LayoutOperationCommit,
  LayoutListener,
  StreamStore
} from './workspace-layout-stream-types'
export type { LayoutOperationCommit, WorkspaceLayoutReads } from './workspace-layout-stream-types'
import {
  reconcileShownLayouts,
  changedLayoutRecords,
  type Shown
} from './workspace-layout-frame-diff'

// Reproject changed Store partitions only while subscribed; overlay live titles without reloading.
// Main-owned layouts emit one records frame per operation, coalescing unscoped writes per task; window-owned layouts emit whole workspaces.

import { randomUUID } from 'node:crypto'
import type { SessionChangeSet } from '../../shared/session-change-set'
import type { ExecutionHostId } from '../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'

import type {
  WorkspaceLayoutEvent,
  WorkspaceLayoutStreamEvent
} from '../../shared/workspace-layout/workspace-layout-stream-frames'

import { withLiveTitles } from './published-pane-live-titles'
import { paneStartFactsOf, withPaneStartFacts, type PaneFactSources } from './pane-start-statuses'
import {
  workspaceLayoutFrameObserver,
  workspaceLayoutPartitionReadObserver
} from './workspace-layout-frame-observer'
import { WorkspaceLayoutProjection, type DirtyPartitions } from './workspace-layout-projection'

/** Partitions written by an operation or task; null when unscoped. */

function addDirty(dirty: DirtyPartitions | null, hostId: ExecutionHostId | null): DirtyPartitions {
  if (hostId === null || dirty === 'all') {
    return 'all'
  }
  return new Set([...(dirty ?? []), hostId])
}

export class WorkspaceLayoutStream {
  private readonly listeners = new Set<LayoutListener>()
  private readonly commitListeners = new Set<(commit: LayoutOperationCommit) => void>()
  private readonly projection: WorkspaceLayoutProjection
  private shown = new Map<string, Shown>()
  private stopWatching: (() => void) | null = null
  private projecting = false
  private dirty = false
  private touched: DirtyPartitions | null = null
  private liveTitlesDirty = false
  private liveOwners: Set<string> | null = new Set()
  private flushQueued = false
  private failureLogged = false
  /** Never reset: replies can retain positions across resubscriptions. */
  private seq = 0
  /** A different epoch tells readers they missed this process's frames. */
  private readonly epoch = ORCA_LAYOUT_OWNER_IS_MAIN ? randomUUID() : undefined

  constructor(
    private readonly deps: PaneFactSources & {
      store: () => StreamStore | null
      homeHostId: (key: string) => ExecutionHostId | null
      liveTitle: (ptyId: string) => string | null
    }
  ) {
    this.projection = new WorkspaceLayoutProjection(deps)
  }

  subscribe(listener: LayoutListener): {
    snapshot: { key: string; layout: PublishedWorkspaceLayout }[]
    seq: number
    /** Present only in main-owned layouts. */
    epoch?: string
    unsubscribe: () => void
  } {
    if (!this.projecting) {
      this.projecting = true
      this.projection.clear()
      this.shown = new Map()
      this.dirty = true
    }
    // Flush pending changes before adding the subscriber so its snapshot is current.
    this.flush()
    this.listeners.add(listener)
    this.watch()
    const snapshot = [...this.shown].map(([key, { layout }]) => ({ key, layout }))
    return {
      snapshot,
      seq: this.seq,
      ...(this.epoch ? { epoch: this.epoch } : {}),
      unsubscribe: () => {
        if (!this.listeners.delete(listener) || this.listeners.size > 0) {
          return
        }
        this.projecting = false
        // A flush already queued finds nothing to project.
        this.dirty = false
        this.liveTitlesDirty = false
        this.shown.clear()
        this.watch()
      }
    }
  }

  /** Observe committed operations/tasks even without layout subscribers. */
  onLayoutOperationCommitted(listener: (commit: LayoutOperationCommit) => void): () => void {
    this.commitListeners.add(listener)
    this.watch()
    return () => {
      this.commitListeners.delete(listener)
      this.watch()
    }
  }

  /** Shared read-only partition while subscribed, otherwise loaded per call; tests freeze it. Null without a Store. */
  readPartition(hostId: ExecutionHostId): LoadedWorkspaceLayout | null {
    const loaded = this.projection.loaded(hostId, this.stopWatching !== null)
    if (loaded) {
      workspaceLayoutPartitionReadObserver()?.(loaded)
    }
    return loaded
  }

  markLiveTitlesDirty(ptyId?: string, paneKey?: string): void {
    if (!this.projecting) {
      return
    }
    this.liveTitlesDirty = true
    const store = this.deps.store()
    if ((!ptyId && !paneKey) || !store?.getWorkspaceSessionReferences) {
      this.liveOwners = null
    } else if (this.liveOwners) {
      for (const host of store.getWorkspaceSessionHostIds?.() ?? []) {
        for (const unit of store.getWorkspaceSessionReferences(
          ptyId ? 'pty' : 'pane',
          ptyId ?? paneKey ?? '',
          host
        )) {
          if (unit.field === 'tabsByWorktree' || unit.field === 'unifiedTabs') {
            this.liveOwners.add(unit.key)
          }
          if (unit.field === 'terminalLayoutsByTabId') {
            for (const owner of store.getWorkspaceSessionReferences('tab', unit.key, host)) {
              if (owner.field === 'tabsByWorktree' || owner.field === 'unifiedTabs') {
                this.liveOwners.add(owner.key)
              }
            }
          }
        }
      }
    }
    this.schedule()
  }

  settledSeq(): number {
    this.flush()
    return this.seq
  }

  private watch(): void {
    const wanted = this.listeners.size > 0 || this.commitListeners.size > 0
    if (wanted && !this.stopWatching) {
      const store = this.deps.store()
      const stopWrites = store?.onWorkspaceSessionWritten?.((hostId, changes) => {
        if (changes) {
          for (const change of changes) {
            this.markDirty(change.hostId, change)
          }
        } else {
          this.markDirty(hostId)
        }
      })
      // Switch point: a window-owned build publishes when the writes' task ends, as before.
      const stopOperations = ORCA_LAYOUT_OWNER_IS_MAIN
        ? store?.onWorkspaceSessionOperationEnded?.(() => this.flush())
        : undefined
      this.stopWatching =
        stopWrites || stopOperations
          ? () => {
              stopWrites?.()
              stopOperations?.()
            }
          : null
    } else if (!wanted && this.stopWatching) {
      this.stopWatching()
      this.stopWatching = null
      // Discard projections when unwatched writes can no longer invalidate them.
      this.projection.clear()
    }
  }

  private schedule(): void {
    if (!this.flushQueued) {
      this.flushQueued = true
      // Coalesces a burst of unscoped writes and title changes in one task into one flush.
      queueMicrotask(() => {
        this.flushQueued = false
        this.flush()
      })
    }
  }

  private markDirty(hostId: ExecutionHostId | null, changes?: SessionChangeSet): void {
    this.projection.invalidate(hostId, changes)
    this.dirty ||= this.projecting
    if (this.commitListeners.size > 0) {
      this.touched = addDirty(this.touched, hostId)
    }
    this.schedule()
  }

  private flush(): void {
    const { dirty, touched } = this
    this.touched = null
    if (dirty || this.liveTitlesDirty) {
      this.dirty = false
      this.liveTitlesDirty = false
      // A failed projection is logged once; it never reaches the write that notified it.
      try {
        this.reconcile(dirty)
      } catch (error) {
        // A partial cache update requires reprojection of every partition on the next write.
        this.projection.forgetPartitions()
        this.logFailure('projection', error)
      }
    }
    if (touched !== null) {
      const commit = { hostIds: touched === 'all' ? null : [...touched] }
      for (const listener of this.commitListeners) {
        try {
          listener(commit)
        } catch (error) {
          this.logFailure('commit listener', error)
        }
      }
    }
  }

  private logFailure(what: string, error: unknown): void {
    if (!this.failureLogged) {
      this.failureLogged = true
      console.warn(`[workspace-layout] layout stream ${what} failed:`, error)
    }
  }

  private liveTitlesOf(layout: PublishedWorkspaceLayout): (string | null)[] {
    return layout.tabs.flatMap((tab) =>
      (tab.terminal?.panes ?? []).map((pane) =>
        pane.ptyId ? this.deps.liveTitle(pane.ptyId) : null
      )
    )
  }

  private reconcile(reproject: boolean): void {
    const next = reproject ? this.projection.project() : this.projection.published
    const projectedKeys = reproject ? this.projection.changedKeys() : new Set<string>()
    const keys =
      projectedKeys === null || this.liveOwners === null
        ? new Set([...next.keys(), ...this.shown.keys()])
        : new Set([...projectedKeys, ...this.liveOwners])
    this.liveOwners = new Set()
    const { removed, before, shown, changed } = reconcileShownLayouts(
      next,
      this.shown,
      keys,
      projectedKeys === null,
      (layout) => {
        const titles = this.liveTitlesOf(layout)
        const starts = ORCA_LAYOUT_OWNER_IS_MAIN ? paneStartFactsOf(layout, this.deps) : null
        const liveTitles = JSON.stringify(starts ? [titles, starts] : titles)
        const titled = withLiveTitles(layout, titles)
        return { liveTitles, layout: starts ? withPaneStartFacts(titled, starts) : titled }
      }
    )
    this.shown = shown
    // Switch point: a window-owned build sends each workspace whole, one frame each.
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || !this.epoch) {
      this.deliverEach([
        ...removed.map((key): WorkspaceLayoutEvent => ({ type: 'removed', key })),
        ...changed.map((key): WorkspaceLayoutEvent => ({
          type: 'workspace',
          key,
          layout: shown.get(key)!.layout
        }))
      ])
      return
    }
    // The first subscriber's own projection reaches no one: its snapshot holds it.
    if (this.listeners.size === 0) {
      return
    }
    const workspaces = changedLayoutRecords(before, shown, removed, changed)
    if (workspaces.length === 0) {
      return
    }
    const frame = { type: 'records' as const, epoch: this.epoch, seq: ++this.seq, workspaces }
    this.deliver(frame)
    workspaceLayoutFrameObserver()?.({
      frame,
      before: new Map(
        [...shown, ...before]
          .filter(([key]) => !changed.includes(key) || before.has(key))
          .map(([key, { layout }]) => [key, layout])
      ),
      fresh: () => this.freshLayouts(),
      titlesOnly: !reproject
    })
  }

  private freshLayouts(): Map<string, PublishedWorkspaceLayout> {
    const fresh = new Map<string, PublishedWorkspaceLayout>()
    for (const [key, { layout }] of this.projection.projectFresh()) {
      const titled = withLiveTitles(layout, this.liveTitlesOf(layout))
      const starts = ORCA_LAYOUT_OWNER_IS_MAIN ? paneStartFactsOf(layout, this.deps) : null
      fresh.set(key, starts ? withPaneStartFacts(titled, starts) : titled)
    }
    return fresh
  }

  private deliverEach(events: WorkspaceLayoutEvent[]): void {
    for (const unsequenced of events) {
      // Assign sequence numbers only when sending so failures cannot leave gaps.
      this.deliver({ ...unsequenced, seq: ++this.seq })
    }
  }

  private deliver(event: WorkspaceLayoutStreamEvent): void {
    for (const listener of this.listeners) {
      // Isolate listener failures so peers still receive the published frame.
      try {
        listener(event)
      } catch (error) {
        this.logFailure('listener', error)
      }
    }
  }
}
