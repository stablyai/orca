import type { Cookie, Cookies } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'

export type CookieClearPartitionKey = {
  topLevelSite: string
  hasCrossSiteAncestor: boolean
}

export type CookieClearIdentity = {
  url: string
  name: string
  value: string
  domain?: string
  hostOnly?: boolean
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite: Cookie['sameSite']
  expirationDate?: number
  partitionKey?: CookieClearPartitionKey
}

export type CookieClearStore = Pick<Cookies, 'get' | 'remove'> & {
  snapshotClearIdentities(
    cookies: readonly { cookie: Cookie; url: string }[]
  ): Promise<CookieClearIdentity[]>
  restoreClearIdentities(identities: readonly CookieClearIdentity[]): Promise<void>
}

// Write through CDP identities because Electron cookies.set loses partition keys.
export type CookieImportWriteStore = Pick<Cookies, 'get' | 'remove'> & {
  writeCookieIdentity(identity: CookieClearIdentity): Promise<void>
}

// Why: cookies.get() leaves out partitionKey, so a whole-jar copy reads through CDP too.
export type CookieJarCdpReadStore = {
  readAllCdpCookies(): Promise<CdpCookie[]>
}

// Exclude cookies.set and bulk clearData: neither preserves this per-cookie rollback contract.
export type CookieClearSession = {
  cookies: Pick<Cookies, 'get' | 'remove'>
  snapshotClearIdentities: CookieClearStore['snapshotClearIdentities']
  restoreClearIdentities: CookieClearStore['restoreClearIdentities']
}
