// The read-only layout stream behind `layout.subscribe`: each workspace's published layout,
// re-projected from the Store's sessions after writes while anyone subscribes. A write that names
// its partition re-projects only that partition. Each pane's live terminal title is laid over the
// cached projection, so a title change costs no projection. With no subscriber it does no work.
//
// A layout-owner build publishes once per main operation (one durable mutation: a `layout.apply`,
// a binding write, a repair), as one records frame of what changed; writes no operation scopes
// (a window save) publish when their task ends. A window-owned build sends a frame per workspace.

import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import {
  diffPublishedLayouts,
  indexPublishedLayout,
  type IndexedLayoutRecords,
  type WorkspaceLayoutRecordChange
} from '../../shared/workspace-layout/workspace-layout-records'
import type {
  WorkspaceLayoutEvent,
  WorkspaceLayoutStreamEvent
} from '../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeStore } from './runtime-store-contract'
import { withLiveTitles } from './published-pane-live-titles'
import { paneStartFactsOf, withPaneStartFacts, type PaneFactSources } from './pane-start-statuses'
import {
  workspaceLayoutFrameObserver,
  workspaceLayoutPartitionReadObserver
} from './workspace-layout-frame-observer'
import {
  WorkspaceLayoutProjection,
  type DirtyPartitions,
  type ProjectionStore
} from './workspace-layout-projection'

type LayoutListener = (event: WorkspaceLayoutStreamEvent) => void

/** A main operation's end, or the end of a task's unscoped writes: the partitions it may have
 *  written; null when any may have changed. */
export type LayoutOperationCommit = { hostIds: readonly ExecutionHostId[] | null }

/** What a workspace was last sent as: its projection's JSON and its panes' live titles. */
type Shown = {
  json: string
  liveTitles: string
  layout: PublishedWorkspaceLayout
  /** Its records, indexed when a later layout is first diffed against it; null: it goes whole. */
  records?: IndexedLayoutRecords | null
}

/** What a reader beside the stream uses instead of a Loader pass of its own. */
export type WorkspaceLayoutReads = Pick<
  WorkspaceLayoutStream,
  'onLayoutOperationCommitted' | 'readPartition'
>

type StreamStore = ProjectionStore &
  Pick<RuntimeStore, 'onWorkspaceSessionWritten' | 'onWorkspaceSessionOperationEnded'>

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
  /** Workspace key → what listeners last received for it, live titles included. */
  private shown = new Map<string, Shown>()
  private stopWatching: (() => void) | null = null
  /** From the first subscriber to the last: only then is anything projected. */
  private projecting = false
  /** A write may have changed what subscribers hold: the next flush re-projects stale partitions. */
  private dirty = false
  /** Partitions written since commit listeners last heard. */
  private touched: DirtyPartitions | null = null
  private liveTitlesDirty = false
  private flushQueued = false
  private failureLogged = false
  /** The last change frame's position; never reset, so a reply's position outlives resubscribes. */
  private seq = 0
  /** Names this stream for the process's life: a reader seeing another one missed frames. */
  private readonly epoch = ORCA_LAYOUT_OWNER_IS_MAIN ? randomUUID() : undefined

  constructor(
    private readonly deps: PaneFactSources & {
      store: () => StreamStore | null
      /** The partition that owns a workspace key; null when none does. */
      homeHostId: (key: string) => ExecutionHostId | null
      /** The title a terminal shows now; null when it has none. */
      liveTitle: (ptyId: string) => string | null
    }
  ) {
    this.projection = new WorkspaceLayoutProjection(deps)
  }

  /** Every workspace's layout now, then each change until `unsubscribe`. */
  subscribe(listener: LayoutListener): {
    snapshot: { key: string; layout: PublishedWorkspaceLayout }[]
    /** The position the snapshot holds. */
    seq: number
    /** A layout-owner build's stream epoch; its records frames carry it. */
    epoch?: string
    unsubscribe: () => void
  } {
    if (!this.projecting) {
      this.projecting = true
      this.projection.clear()
      this.shown = new Map()
      this.dirty = true
    }
    // A change not yet published reaches existing listeners first, so the snapshot is current.
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

  /**
   * Each main operation's end once its writes are in, with the partitions it may have written,
   * and each task's unscoped writes. Heard with or without a layout subscriber.
   */
  onLayoutOperationCommitted(listener: (commit: LayoutOperationCommit) => void): () => void {
    this.commitListeners.add(listener)
    this.watch()
    return () => {
      this.commitListeners.delete(listener)
      this.watch()
    }
  }

  /**
   * One session partition's loaded model (layout, view and facts), the one the stream publishes
   * from: shared while anyone listens (cached until a write may change it), else loaded per call.
   * READ-ONLY: the stream and every other reader see the same object; tests freeze it. Null with
   * no Store.
   */
  readPartition(hostId: ExecutionHostId): LoadedWorkspaceLayout | null {
    const loaded = this.projection.loaded(hostId, this.stopWatching !== null)
    if (loaded) {
      workspaceLayoutPartitionReadObserver()?.(loaded)
    }
    return loaded
  }

  /** Some terminal's title may have changed; republishes only the panes whose title did. */
  markLiveTitlesDirty(): void {
    if (!this.projecting) {
      return
    }
    this.liveTitlesDirty = true
    this.schedule()
  }

  /** The position holding every write made so far: a pending flush is sent first. */
  settledSeq(): number {
    this.flush()
    return this.seq
  }

  private watch(): void {
    const wanted = this.listeners.size > 0 || this.commitListeners.size > 0
    if (wanted && !this.stopWatching) {
      const store = this.deps.store()
      const stopWrites = store?.onWorkspaceSessionWritten?.((hostId) => this.markDirty(hostId))
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
      // Unwatched writes would go unseen: nothing projected may be read again.
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

  private markDirty(hostId: ExecutionHostId | null): void {
    this.projection.invalidate(hostId)
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
        // The cache may be part-updated; the next write re-projects every partition.
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

  /** Every pane's live title, in tab and pane order; null for a pane with none. */
  private liveTitlesOf(layout: PublishedWorkspaceLayout): (string | null)[] {
    return layout.tabs.flatMap((tab) =>
      (tab.terminal?.panes ?? []).map((pane) =>
        pane.ptyId ? this.deps.liveTitle(pane.ptyId) : null
      )
    )
  }

  private reconcile(reproject: boolean): void {
    const next = reproject ? this.projection.project() : this.projection.published
    const removed: string[] = []
    for (const key of this.shown.keys()) {
      if (!next.has(key)) {
        removed.push(key)
      }
    }
    const before = this.shown
    const shown = new Map<string, Shown>()
    const changed: string[] = []
    for (const [key, { layout, json }] of next) {
      const titles = this.liveTitlesOf(layout)
      // Switch point: a pane's start facts are live state, laid over as its title is.
      const starts = ORCA_LAYOUT_OWNER_IS_MAIN ? paneStartFactsOf(layout, this.deps) : null
      const liveTitles = JSON.stringify(starts ? [titles, starts] : titles)
      const previous = before.get(key)
      if (previous?.json === json && previous.liveTitles === liveTitles) {
        shown.set(key, previous)
        continue
      }
      const shownLayout = withLiveTitles(layout, titles)
      const laid = starts ? withPaneStartFacts(shownLayout, starts) : shownLayout
      shown.set(key, { json, liveTitles, layout: laid })
      changed.push(key)
    }
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
    const workspaces: WorkspaceLayoutRecordChange[] = removed.map((key) => ({
      key,
      change: 'removed'
    }))
    for (const key of changed) {
      const previous = before.get(key)
      const current = shown.get(key)!
      const change = previous
        ? diffPublishedLayouts(key, recordsOf(previous), recordsOf(current), current.layout)
        : { key, change: 'layout' as const, layout: current.layout }
      if (change) {
        workspaces.push(change)
      }
    }
    if (workspaces.length === 0) {
      return
    }
    const frame = { type: 'records' as const, epoch: this.epoch, seq: ++this.seq, workspaces }
    this.deliver(frame)
    workspaceLayoutFrameObserver()?.({
      frame,
      before: new Map([...before].map(([key, { layout }]) => [key, layout])),
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
      // Numbered as sent, so a failed projection never skips a position a reply could name.
      this.deliver({ ...unsequenced, seq: ++this.seq })
    }
  }

  private deliver(event: WorkspaceLayoutStreamEvent): void {
    for (const listener of this.listeners) {
      // One failing listener must not cost the others an event the stream has now published.
      try {
        listener(event)
      } catch (error) {
        this.logFailure('listener', error)
      }
    }
  }
}

function recordsOf(shown: Shown): IndexedLayoutRecords | null {
  if (shown.records === undefined) {
    shown.records = indexPublishedLayout(shown.layout)
  }
  return shown.records
}
