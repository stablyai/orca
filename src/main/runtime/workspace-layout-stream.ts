// The read-only layout stream behind `layout.subscribe`: each workspace's published layout,
// re-projected from the Store's sessions after every write while anyone subscribes. A write that
// names its partition re-projects only that partition. Each pane's live terminal title is laid
// over the cached projection, so a title change costs no projection. Nothing reads it until a
// client opts in; with no subscriber it does no work.

import type { ExecutionHostId } from '../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayoutEvent } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeStore } from './runtime-store-contract'

type LayoutListener = (event: WorkspaceLayoutEvent) => void

type Published = { layout: PublishedWorkspaceLayout; json: string }

/** What a workspace was last sent as: its projection's JSON and its panes' live titles. */
type Shown = { json: string; liveTitles: string; layout: PublishedWorkspaceLayout }

type StreamStore = Pick<
  RuntimeStore,
  'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'onWorkspaceSessionWritten'
>

export class WorkspaceLayoutStream {
  private readonly listeners = new Set<LayoutListener>()
  /** Workspace key → its published layout, with its JSON for the by-value comparison. */
  private published = new Map<string, Published>()
  /** Workspace key → what listeners last received for it, live titles included. */
  private shown = new Map<string, Shown>()
  /** Partition → every workspace it holds, its own copy of a workspace it does not own included. */
  private projectedPartitions = new Map<ExecutionHostId, Map<string, Published>>()
  private stopWatching: (() => void) | null = null
  /** Partitions to re-project at the next flush; 'all' when a write did not name its partition. */
  private dirty: Set<ExecutionHostId> | 'all' | null = null
  private liveTitlesDirty = false
  private failureLogged = false
  /** Its own flag, so a routing warning never hides a later projection or listener failure. */
  private routingFailureLogged = false
  /** The last change frame's position; never reset, so a reply's position outlives resubscribes. */
  private seq = 0

  constructor(
    private readonly deps: {
      store: () => StreamStore | null
      /** The partition that owns a workspace key; null when none does. */
      homeHostId: (key: string) => ExecutionHostId | null
      /** The title a terminal shows now; null when it has none. */
      liveTitle: (ptyId: string) => string | null
    }
  ) {}

  /** Every workspace's layout now, then each change until `unsubscribe`. */
  subscribe(listener: LayoutListener): {
    snapshot: { key: string; layout: PublishedWorkspaceLayout }[]
    /** The position the snapshot holds. */
    seq: number
    unsubscribe: () => void
  } {
    if (this.listeners.size === 0) {
      this.stopWatching =
        this.deps.store()?.onWorkspaceSessionWritten?.((hostId) => this.markDirty(hostId)) ?? null
      this.published = new Map()
      this.shown = new Map()
      this.projectedPartitions = new Map()
      this.dirty = 'all'
    }
    // A change not yet published reaches existing listeners first, so the snapshot is current.
    this.flush()
    this.listeners.add(listener)
    const snapshot = [...this.shown].map(([key, { layout }]) => ({ key, layout }))
    return {
      snapshot,
      seq: this.seq,
      unsubscribe: () => {
        if (!this.listeners.delete(listener) || this.listeners.size > 0) {
          return
        }
        this.stopWatching?.()
        this.stopWatching = null
        // A flush already queued finds nothing to do.
        this.dirty = null
        this.liveTitlesDirty = false
        this.published.clear()
        this.shown.clear()
        this.projectedPartitions.clear()
      }
    }
  }

  /** Some terminal's title may have changed; republishes only the panes whose title did. */
  markLiveTitlesDirty(): void {
    if (this.listeners.size === 0) {
      return
    }
    this.schedule()
    this.liveTitlesDirty = true
  }

  /** The position holding every write made so far: a pending flush is sent first. */
  settledSeq(): number {
    this.flush()
    return this.seq
  }

  private schedule(): void {
    if (this.dirty === null && !this.liveTitlesDirty) {
      // Coalesces a burst of writes and title changes in one task into one flush.
      queueMicrotask(() => this.flush())
    }
  }

  private markDirty(hostId: ExecutionHostId | null): void {
    this.schedule()
    if (hostId === null) {
      this.dirty = 'all'
    } else if (this.dirty === null) {
      this.dirty = new Set([hostId])
    } else if (this.dirty !== 'all') {
      this.dirty.add(hostId)
    }
  }

  private flush(): void {
    const dirty = this.dirty
    if (dirty === null && !this.liveTitlesDirty) {
      return
    }
    this.dirty = null
    this.liveTitlesDirty = false
    // A failed projection is logged once; it never reaches the write that notified it.
    try {
      this.reconcile(dirty)
    } catch (error) {
      // The cache may be part-updated; the next write re-projects every partition.
      this.projectedPartitions.clear()
      this.logFailure('projection', error)
    }
  }

  private logFailure(what: string, error: unknown): void {
    if (!this.failureLogged) {
      this.failureLogged = true
      console.warn(`[workspace-layout] layout stream ${what} failed:`, error)
    }
  }

  private projectPartition(hostId: ExecutionHostId): Map<string, Published> {
    const projected = new Map<string, Published>()
    const session = this.deps.store()?.getWorkspaceSession?.(hostId)
    if (!session) {
      return projected
    }
    const { layout } = loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
    for (const [key, workspace] of Object.entries(layout.workspaces)) {
      const published = publishWorkspaceLayout(workspace, hostId)
      projected.set(key, { layout: published, json: stableJson(published) })
    }
    return projected
  }

  private project(dirty: Set<ExecutionHostId> | 'all'): Map<string, Published> {
    const hostIds = this.deps.store()?.getWorkspaceSessionHostIds?.() ?? []
    const partitions = new Map<ExecutionHostId, Map<string, Published>>()
    for (const hostId of hostIds) {
      const cached =
        dirty === 'all' || dirty.has(hostId) ? undefined : this.projectedPartitions.get(hostId)
      partitions.set(hostId, cached ?? this.projectPartition(hostId))
    }
    this.projectedPartitions = partitions
    const projected = new Map<string, Published>()
    const unroutable = new Set<string>()
    for (const [hostId, workspaces] of partitions) {
      for (const [key, workspace] of workspaces) {
        // Only the owning partition's copy is published; a stray copy elsewhere is not shown.
        if (this.homeOf(key, unroutable) === hostId) {
          projected.set(key, workspace)
        }
      }
    }
    for (const key of unroutable) {
      const kept = this.published.get(key)
      // Kept as last published: a 'removed' frame would make the window drop its tabs.
      if (kept && !projected.has(key)) {
        projected.set(key, kept)
      }
    }
    return projected
  }

  /**
   * A workspace the router throws on is not guessed (`repoId::path` repeats across hosts, so a
   * default could publish another host's copy); it is noted in `unroutable`. It never stops the rest.
   */
  private homeOf(key: string, unroutable: Set<string>): ExecutionHostId | null {
    try {
      return this.deps.homeHostId(key)
    } catch (error) {
      // Switch point: a window-owned build keeps failing the whole projection, as today.
      if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
        throw error
      }
      unroutable.add(key)
      if (!this.routingFailureLogged) {
        this.routingFailureLogged = true
        console.warn('[workspace-layout] layout stream routing failed:', error)
      }
      return null
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

  private reconcile(dirty: Set<ExecutionHostId> | 'all' | null): void {
    const next = dirty === null ? this.published : this.project(dirty)
    const events: WorkspaceLayoutEvent[] = []
    for (const key of this.shown.keys()) {
      if (!next.has(key)) {
        events.push({ type: 'removed', key })
      }
    }
    const shown = new Map<string, Shown>()
    for (const [key, { layout, json }] of next) {
      const titles = this.liveTitlesOf(layout)
      const liveTitles = JSON.stringify(titles)
      const previous = this.shown.get(key)
      if (previous?.json === json && previous.liveTitles === liveTitles) {
        shown.set(key, previous)
        continue
      }
      const withTitles = withLiveTitles(layout, titles)
      shown.set(key, { json, liveTitles, layout: withTitles })
      events.push({ type: 'workspace', key, layout: withTitles })
    }
    this.published = next
    this.shown = shown
    for (const unsequenced of events) {
      // Numbered as sent, so a failed projection never skips a position a reply could name.
      const event = { ...unsequenced, seq: ++this.seq }
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
}

function withLiveTitles(
  layout: PublishedWorkspaceLayout,
  titles: (string | null)[]
): PublishedWorkspaceLayout {
  if (titles.every((title) => title === null)) {
    return layout
  }
  let index = 0
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.terminal
        ? {
            ...tab,
            terminal: {
              ...tab.terminal,
              panes: tab.terminal.panes.map((pane) => {
                const liveTitle = titles[index++]
                return liveTitle === null ? pane : { ...pane, liveTitle }
              })
            }
          }
        : tab
    )
  }
}
