import type { ClickUpTaskListFilter, ClickUpTaskPage } from '../../shared/clickup/clickup-types'

// Consecutive keystrokes rescan the same pages; a short TTL keeps them local without hiding new tasks for long.
const TTL_MS = 45_000
const MAX_CACHED_PAGES = 30

type CachedPage = { page: ClickUpTaskPage; expiresAt: number }

const pages = new Map<string, CachedPage>()
let epoch = 0

export function clickUpScanPageKey(
  scope: { workspaceId: string; viewerId: string | null },
  filter: ClickUpTaskListFilter,
  page: number
): string {
  return JSON.stringify([
    scope.workspaceId,
    scope.viewerId,
    filter.scope,
    filter.includeClosed,
    [...(filter.statuses ?? [])].sort(),
    page
  ])
}

export function readScannedClickUpPage(key: string): ClickUpTaskPage | null {
  const entry = pages.get(key)
  if (!entry) {
    return null
  }
  if (entry.expiresAt <= Date.now()) {
    pages.delete(key)
    return null
  }
  return entry.page
}

/** Identifies the cache generation; a fetch started under an older one must not write its page. */
export function scannedClickUpPagesEpoch(): number {
  return epoch
}

/** A clear between the fetch and this write means the page may predate the change that caused it, so it is dropped. */
export function writeScannedClickUpPage(
  key: string,
  page: ClickUpTaskPage,
  fetchedAtEpoch: number
): void {
  if (fetchedAtEpoch !== epoch) {
    return
  }
  pages.delete(key)
  pages.set(key, { page, expiresAt: Date.now() + TTL_MS })
  while (pages.size > MAX_CACHED_PAGES) {
    const oldest = pages.keys().next()
    if (oldest.done) {
      break
    }
    pages.delete(oldest.value)
  }
}

/** Drops every scanned page; called when the token, the Workspace or a task changes. */
export function clearScannedClickUpPages(): void {
  epoch += 1
  pages.clear()
}
