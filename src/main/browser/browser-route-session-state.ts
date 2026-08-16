import type { BrowserRoutePreparedPageLedger } from './browser-route-prepared-page-ledger'
import type { BrowserRoutePageAuthority } from './browser-route-page-authority'
import type {
  BrowserRouteElectronSession,
  BrowserRouteProxyEndpoint
} from './browser-route-session-policy'

export type BrowserRouteSessionHandle = Readonly<{
  partition: string
  release: () => void
}>

export type BrowserRouteSessionRekey = Readonly<{
  page: BrowserRoutePageAuthority
  routeSession: BrowserRouteSessionHandle
}>

export type PreparedBrowserRoutePartition = {
  partition: string
  bindingFingerprint: string
  browserProfileId: string
  proxyEndpoint: BrowserRouteProxyEndpoint
  session: BrowserRouteElectronSession
  pages: BrowserRoutePreparedPageLedger
}

export type PendingBrowserRoutePartition = {
  partition: string
  bindingFingerprint: string
  proxyEndpoint: BrowserRouteProxyEndpoint
  promise: Promise<PreparedBrowserRoutePartition>
  state: PreparedBrowserRoutePartition | null
  waiters: number
  admitted: boolean
}
