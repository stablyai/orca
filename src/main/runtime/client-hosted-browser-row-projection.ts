import type { ClientHostedBrowserRow } from '../../shared/client-hosted-browser-rows'
import type { RuntimeBrowserClientPage } from './runtime-browser-page-registry'

export type ClientHostedBrowserRowSources = {
  /** False once the lease that placed the page is gone — the page is retained but undriveable. */
  hasLivePlacement(browserPageId: string): boolean
  resolveDeviceName(pairedDeviceId: string): string | null
}

/** Omit active: scoped listPages and global hydration legitimately normalize it differently. */
export function projectClientHostedBrowserRows(
  pages: readonly RuntimeBrowserClientPage[],
  sources: ClientHostedBrowserRowSources
): ClientHostedBrowserRow[] {
  return pages.map((page) => {
    const hostAbsent = !sources.hasLivePlacement(page.browserPageId)
    return {
      browserPageId: page.browserPageId,
      worktreeId: page.workspaceId,
      url: page.url,
      title: page.title,
      // An absent host cannot finish a carried-over load spinner.
      loading: hostAbsent ? false : page.loading,
      browserHostClientId: page.placement.browserHostClientId,
      hostDeviceName: page.pairedDeviceId ? sources.resolveDeviceName(page.pairedDeviceId) : null,
      hostAbsent
    }
  })
}
