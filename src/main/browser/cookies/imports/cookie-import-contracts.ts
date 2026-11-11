import type { CookieClearStore, CookieImportWriteStore } from '../storage/cookie-store-contracts'

export type CookieImportSessionStore = CookieClearStore &
  CookieImportWriteStore & { dispose: () => void }

export type CookieImportTarget = {
  partition: string
  // Reuse the Electron Session as the lock key across import paths; a fresh adapter would not serialize.
  mutationLockOwner: object
  openWriteStore: () => CookieImportSessionStore
  flushStore?: () => Promise<void>
}

export type CookieImportOptions = {
  canReportPartitionSkippedCookies?: boolean
}
