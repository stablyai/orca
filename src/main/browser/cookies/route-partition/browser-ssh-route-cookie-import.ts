import type { BrowserCookieImportResult } from '../../../../shared/browser/workspaces/browser-workspace-types'
import {
  browserCookieImportFailure,
  type BrowserCookieImportFailure
} from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { preparedLocalSshBrowserPartition } from '../../routing/local-host-partitions/local-ssh-browser-partitions'
import {
  browserCookieImportSource,
  cookieFileImportSource,
  importIntoRoutePartition,
  type RouteCookieImportSource
} from './browser-route-partition-cookie-import'

/** A page routed through an SSH host: its cookies live in that host's jar, not the profile's. */
export type SshRouteCookieImportTarget = {
  sshTargetId: string
  browserProfileId: string
}

export function importCookiesIntoSshRoutePartition(
  request: SshRouteCookieImportTarget & { browserFamily: string; browserProfile?: string }
): Promise<BrowserCookieImportResult> {
  return importIntoSshRoutePartition(request, async () => browserCookieImportSource(request))
}

export function importCookieFileIntoSshRoutePartition(
  target: SshRouteCookieImportTarget,
  pickFile: () => Promise<string | null>
): Promise<BrowserCookieImportResult> {
  return importIntoSshRoutePartition(target, () => cookieFileImportSource(pickFile))
}

async function importIntoSshRoutePartition(
  target: SshRouteCookieImportTarget,
  resolveSource: () => Promise<RouteCookieImportSource | BrowserCookieImportFailure>
): Promise<BrowserCookieImportResult> {
  if (!browserSessionRegistry.getProfile(target.browserProfileId)) {
    return browserCookieImportFailure('profileNotFound')
  }
  const resolvePartition = (): string | null =>
    preparedLocalSshBrowserPartition(target.sshTargetId, target.browserProfileId)
  // Refuse before the file picker opens; the page that asked has already prepared this jar.
  if (resolvePartition() === null) {
    return browserCookieImportFailure('sshHostDisconnected')
  }
  const imported = await importIntoRoutePartition(
    {
      bindPartition: resolvePartition,
      currentPartition: resolvePartition,
      routeChanged: () => browserCookieImportFailure('sshHostDisconnected')
    },
    resolveSource
  )
  // No profile badge: the profile's own jar is unchanged.
  return imported.ok ? { ...imported.result, profileId: target.browserProfileId } : imported
}
