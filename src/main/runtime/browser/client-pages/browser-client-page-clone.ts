import { BrowserError } from '../../../browser/browser-error'
import type { BrowserHostLease } from '../../browser-host/leases/browser-host-lease-records'
import {
  BROWSER_HOST_UNAVAILABLE_MESSAGE,
  createBrowserClientPage,
  type BrowserClientPageOpeningHost
} from './browser-client-page-opening'
import type { RuntimeBrowserClientPage } from './runtime-browser-page-registry'

/** Opens the page again on the desktop that hosts it, so the copy stays beside it. */
export async function cloneBrowserClientPage(
  host: BrowserClientPageOpeningHost,
  source: RuntimeBrowserClientPage,
  browserProfileId: string
): Promise<{ browserPageId: string }> {
  let lease: BrowserHostLease
  try {
    lease = host.getBrowserHostLeaseRegistry().select(source.placement.browserHostClientId)
  } catch (error) {
    if (error instanceof Error && error.message === 'browser_host_unavailable') {
      throw new BrowserError('browser_host_unavailable', BROWSER_HOST_UNAVAILABLE_MESSAGE)
    }
    throw error
  }
  return createBrowserClientPage(
    host,
    {
      url: source.url,
      activate: false,
      placement: { kind: 'client', browserHostClientId: lease.browserHostClientId }
    },
    {
      worktree: await host.resolveBrowserWorkspace(`id:${source.workspaceId}`),
      browserProfileId,
      caller: { pairedDeviceId: lease.pairedDeviceId, clientKind: 'runtime' }
    }
  )
}
