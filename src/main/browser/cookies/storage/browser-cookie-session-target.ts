import { session } from 'electron'
import { openCookieClearStore } from '../browser-cookie-clear-store'
import type { CookieImportTarget } from '../imports/cookie-import-contracts'

export function cookieImportTarget(targetPartition: string): CookieImportTarget {
  const targetSession = session.fromPartition(targetPartition)
  return {
    partition: targetPartition,
    mutationLockOwner: targetSession,
    openWriteStore: () => openCookieClearStore(targetSession),
    flushStore: () => targetSession.cookies.flushStore()
  }
}
