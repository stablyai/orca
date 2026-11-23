import { browserManager } from '../../../browser/guest-lifecycle/manager/browser-manager'
import type { RuntimeBrowserTabClose } from '../tabs/browser-tab-close'
import type { RuntimeBrowserScreencasts } from '../screencast/browser-screencasts'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

/** A window's tabs of a deleted profile load nowhere; a server's would stay in its wiped session or reopen in Default, so they close. */
export async function closeServerPagesInDeletedProfile(
  host: Pick<
    RuntimeBrowserCommandHost,
    'getOffscreenBrowserBackend' | 'getAvailableAuthoritativeWindowId' | 'serveBrowserTabs'
  >,
  close: Pick<RuntimeBrowserTabClose, 'browserTabClose'>,
  guestSwaps: Pick<RuntimeBrowserScreencasts['guestSwaps'], 'replace'>,
  profileId: string
): Promise<void> {
  const offscreen = host.getOffscreenBrowserBackend()
  if (!offscreen || host.getAvailableAuthoritativeWindowId() !== null) {
    return
  }
  const pages = new Map<string, string | undefined>(
    (host.serveBrowserTabs?.pagesInProfile(profileId) ?? []).map((page) => [
      page.pageId,
      page.worktreeId
    ])
  )
  for (const pageId of offscreen.pageIdsInProfile?.(profileId) ?? []) {
    if (!pages.has(pageId)) {
      pages.set(pageId, browserManager.getWorktreeIdForTab(pageId))
    }
  }
  for (const [page, worktreeId] of pages) {
    // Inside the page's swap fence, so a switch to another profile either finished first or waits.
    await guestSwaps
      .replace(page, async () => {
        const stillInProfile = offscreen.ownsTab(page)
          ? browserManager.getSessionProfileIdForTab(page) === profileId
          : (host.serveBrowserTabs?.pagesInProfile(profileId) ?? []).some(
              (saved) => saved.pageId === page
            )
        if (stillInProfile) {
          await close.browserTabClose({
            page,
            ...(worktreeId ? { worktree: `id:${worktreeId}` } : {})
          })
        }
      })
      .catch((error) => {
        console.warn('[browser-profiles] Failed to close a page of a deleted profile', error)
      })
  }
}
