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

/** Host rows must publish without RPC subscribers; paired-client snapshot gates cannot govern the host view. */
export class ClientHostedBrowserRowPublisher {
  // Track delivered workspaces so empty rows retract once.
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
    // Terminal/editor churn also reaches this seam; suppress never-published empty workspaces.
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

  /** Record hydration as delivery or later empty publication cannot retract the rows. */
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
    // Hydration clears/replaces the renderer's rows; replace this set too, healing stale-window deliveries.
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
