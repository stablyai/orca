import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import { projectClientHostedBrowserRows } from './client-hosted-browser-row-projection'
import type { RuntimeBrowserClientPage } from './runtime-browser-page-registry'

export type ClientHostedBrowserRowPublicationHost = {
  listClientPages(worktreeId?: string): readonly RuntimeBrowserClientPage[]
  hasLivePlacement(browserPageId: string): boolean
  resolveDeviceName(pairedDeviceId: string): string | null
  /** Null while no host renderer is attached; hydration replays the snapshot when one arrives. */
  getEmitter(): ((event: ClientHostedBrowserRowsEvent) => void) | null
}

/**
 * Pushes the host desktop's rows for client-placed browser pages. Deliberately separate from the
 * session-tabs snapshot it rides on: that snapshot is the paired-CLIENT view and is gated on
 * having RPC subscribers, while the host still needs its row after the client that made the page
 * has quit.
 */
export class ClientHostedBrowserRowPublisher {
  // Which workspaces the renderer currently holds rows for, so an emptied one is retracted once.
  private readonly publishedWorktreeIds = new Set<string>()

  constructor(private readonly host: ClientHostedBrowserRowPublicationHost) {}

  publish(worktreeId: string): void {
    const emit = this.host.getEmitter()
    if (!emit) {
      return
    }
    this.publishPages(worktreeId, this.host.listClientPages(worktreeId), emit)
  }

  private publishPages(
    worktreeId: string,
    pages: readonly RuntimeBrowserClientPage[],
    emit: (event: ClientHostedBrowserRowsEvent) => void
  ): void {
    const rows = this.buildRows(pages)
    // Why: the announcement this rides on also fires on terminal and editor churn, so most calls
    // concern a workspace that has never had a client page. Only speak up when something changed.
    if (rows.length === 0 && !this.publishedWorktreeIds.has(worktreeId)) {
      return
    }
    if (rows.length === 0) {
      this.publishedWorktreeIds.delete(worktreeId)
    } else {
      this.publishedWorktreeIds.add(worktreeId)
    }
    emit({ worktreeId, rows })
  }

  publishAll(): void {
    const pagesByWorktreeId = new Map<string, RuntimeBrowserClientPage[]>()
    for (const page of this.host.listClientPages()) {
      const pages = pagesByWorktreeId.get(page.workspaceId)
      if (pages) {
        pages.push(page)
      } else {
        pagesByWorktreeId.set(page.workspaceId, [page])
      }
    }
    for (const worktreeId of new Set([...this.publishedWorktreeIds, ...pagesByWorktreeId.keys()])) {
      const emit = this.host.getEmitter()
      if (emit) {
        this.publishPages(worktreeId, pagesByWorktreeId.get(worktreeId) ?? [], emit)
      }
    }
  }

  /**
   * Answers a renderer hydrating its rows, and records the answer as delivered. This is the other
   * half of `publish`, not a read-only peek: a window that came up in a no-notifier gap learns
   * about its rows only here, and an unrecorded delivery is unretractable — the emptied publish
   * that should take the row back is the very one the never-published suppression swallows.
   */
  deliverHydrationSnapshot(): ClientHostedBrowserRowsEvent[] {
    const pagesByWorktreeId = new Map<string, RuntimeBrowserClientPage[]>()
    for (const page of this.host.listClientPages()) {
      const pages = pagesByWorktreeId.get(page.workspaceId)
      if (pages) {
        pages.push(page)
      } else {
        pagesByWorktreeId.set(page.workspaceId, [page])
      }
    }
    // Replaced, not added to: the renderer clears before applying, so this set is its whole
    // contents afterwards. Re-deriving it every hydration is also what heals a stale entry left
    // by a window that went away between a publish and its retraction.
    this.publishedWorktreeIds.clear()
    for (const worktreeId of pagesByWorktreeId.keys()) {
      this.publishedWorktreeIds.add(worktreeId)
    }
    return [...pagesByWorktreeId].map(([worktreeId, pages]) => ({
      worktreeId,
      rows: this.buildRows(pages)
    }))
  }

  private buildRows(
    pages: readonly RuntimeBrowserClientPage[]
  ): ClientHostedBrowserRowsEvent['rows'] {
    return projectClientHostedBrowserRows(pages, {
      hasLivePlacement: (browserPageId) => this.host.hasLivePlacement(browserPageId),
      resolveDeviceName: (pairedDeviceId) => this.host.resolveDeviceName(pairedDeviceId)
    })
  }
}
