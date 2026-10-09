// The read-only layout stream behind `layout.subscribe`: each workspace's published layout,
// re-projected from the Store's sessions after every write while anyone subscribes. Nothing reads
// it until a client opts in; with no subscriber it does no work.

import type { ExecutionHostId } from '../../shared/execution-host'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
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

type StreamStore = Pick<
  RuntimeStore,
  'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'onWorkspaceSessionWritten'
>

export class WorkspaceLayoutStream {
  private readonly listeners = new Set<LayoutListener>()
  /** Workspace key → its published layout, with its JSON for the by-value comparison. */
  private published = new Map<string, Published>()
  private stopWatching: (() => void) | null = null
  private dirty = false
  private failureLogged = false

  constructor(
    private readonly deps: {
      store: () => StreamStore | null
      /** The partition that owns a workspace key; null when none does. */
      homeHostId: (key: string) => ExecutionHostId | null
    }
  ) {}

  /** Every workspace's layout now, then each change until `unsubscribe`. */
  subscribe(listener: LayoutListener): {
    snapshot: { key: string; layout: PublishedWorkspaceLayout }[]
    unsubscribe: () => void
  } {
    if (this.listeners.size === 0) {
      this.stopWatching =
        this.deps.store()?.onWorkspaceSessionWritten?.(() => this.markDirty()) ?? null
      this.published = new Map()
      this.dirty = true
    }
    // A write not yet published reaches existing listeners first, so the snapshot is current.
    this.flush()
    this.listeners.add(listener)
    const snapshot = [...this.published].map(([key, { layout }]) => ({ key, layout }))
    return {
      snapshot,
      unsubscribe: () => {
        if (!this.listeners.delete(listener) || this.listeners.size > 0) {
          return
        }
        this.stopWatching?.()
        this.stopWatching = null
        this.published.clear()
      }
    }
  }

  private markDirty(): void {
    if (this.dirty) {
      return
    }
    this.dirty = true
    // Coalesces a burst of writes in one task into one projection.
    queueMicrotask(() => this.flush())
  }

  private flush(): void {
    if (!this.dirty) {
      return
    }
    this.dirty = false
    // A failed projection is logged once; it never reaches the write that notified it.
    try {
      this.reconcile()
    } catch (error) {
      this.logFailure('projection', error)
    }
  }

  private logFailure(what: string, error: unknown): void {
    if (!this.failureLogged) {
      this.failureLogged = true
      console.warn(`[workspace-layout] layout stream ${what} failed:`, error)
    }
  }

  private project(): Map<string, Published> {
    const store = this.deps.store()
    const projected = new Map<string, Published>()
    for (const hostId of store?.getWorkspaceSessionHostIds?.() ?? []) {
      const session = store?.getWorkspaceSession?.(hostId)
      if (!session) {
        continue
      }
      const { layout } = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
      for (const [key, workspace] of Object.entries(layout.workspaces)) {
        // Only the owning partition's copy is published; a stray copy elsewhere is not shown.
        if (this.deps.homeHostId(key) === hostId) {
          const layout = publishWorkspaceLayout(workspace, hostId)
          projected.set(key, { layout, json: stableJson(layout) })
        }
      }
    }
    return projected
  }

  private reconcile(): void {
    const next = this.project()
    const events: WorkspaceLayoutEvent[] = []
    for (const key of this.published.keys()) {
      if (!next.has(key)) {
        events.push({ type: 'removed', key })
      }
    }
    for (const [key, { layout, json }] of next) {
      if (this.published.get(key)?.json !== json) {
        events.push({ type: 'workspace', key, layout })
      }
    }
    this.published = next
    for (const event of events) {
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
