import { session } from 'electron'
import {
  browserCookieImportFailure,
  type BrowserCookieImportFailure
} from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { withCookieImportSourceLock } from '../mutation/cookie-mutation-lock'
import type { RouteCookieImportSource } from '../route-partition/browser-route-partition-cookie-import'

export function importCookiesIntoBrowserProfile(
  profile: BrowserSessionProfile,
  resolveSource: (
    source: BrowserSessionProfile['source']
  ) => RouteCookieImportSource | BrowserCookieImportFailure
) {
  const { id, partition } = profile
  return withCookieImportSourceLock(session.fromPartition(partition), async () => {
    const current = browserSessionRegistry.getProfile(id)
    if (current?.partition !== partition) {
      return browserCookieImportFailure('profileNotFound')
    }
    const source = resolveSource(current.source)
    if ('reason' in source) {
      return source
    }
    const result = await source.importInto(partition)
    if (browserSessionRegistry.getProfile(id)?.partition !== partition) {
      return browserCookieImportFailure('profileNotFound')
    }
    if (result.ok && result.summary.importedCookies > 0) {
      browserSessionRegistry.updateProfileSource(id, source.importedSource())
    }
    return result
  })
}
