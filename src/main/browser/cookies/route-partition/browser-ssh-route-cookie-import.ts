import type { BrowserCookieImportResult } from '../../../../shared/browser/workspaces/browser-workspace-types'
import {
  browserCookieImportFailure,
  type BrowserCookieImportFailure
} from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { preparedLocalSshBrowserPartition } from '../../routing/local-host-partitions/local-ssh-browser-partitions'
import { bindLocalSshBrowserPartition } from '../../routing/local-host-partitions/local-ssh-browser-partition-bindings'
import {
  recordClientRouteCookieImportSource,
  sshCookieImportRoute
} from '../client-route/client-route-cookie-import-source-store'
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
  /** A configured host's jar can be filled from Settings before any of its pages opens. */
  targetRegistered: boolean
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
    preparedLocalSshBrowserPartition(target.sshTargetId, target.browserProfileId) ??
    (target.targetRegistered
      ? bindLocalSshBrowserPartition(target.sshTargetId, target.browserProfileId)
      : null)
  // Refuse before the file picker opens: an unknown host has no jar to fill.
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
  if (!imported.ok) {
    return imported
  }
  // Badge the host's jar on this desktop; the profile's own jar and badge are unchanged.
  await recordClientRouteCookieImportSource({
    route: sshCookieImportRoute(target.sshTargetId),
    profileId: target.browserProfileId,
    source: { ...imported.source.badge, importedAt: Date.now() }
  })
  return { ...imported.result, profileId: target.browserProfileId }
}
