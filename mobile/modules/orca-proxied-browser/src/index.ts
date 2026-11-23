import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core'
import type { ComponentType, RefAttributes } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'

export type ProxiedBrowserProxyEvents = {
  // A web view asked the proxy for a connection; answer with proxyAccept or proxyReject.
  onProxyOpen: (event: { proxy: string; connection: number; host: string; port: number }) => void
  onProxyData: (event: { connection: number; data: string }) => void
  // The page finished sending on this connection.
  onProxyEnd: (event: { connection: number }) => void
  onProxyClosed: (event: { connection: number }) => void
}

export type OrcaProxiedBrowserModule = {
  // iOS 17+: older systems cannot point a web view at a proxy.
  isSupported(): boolean
  /** Loopback SOCKS5 port for this proxy key, started once per app launch. */
  startProxy(key: string): Promise<number>
  stopProxy(key: string): Promise<void>
  proxyAccept(connection: number): void
  proxyReject(connection: number): void
  proxyWrite(connection: number, data: Uint8Array): void
  // The destination finished sending.
  proxyEnd(connection: number): void
  proxyClose(connection: number): void
  addListener<E extends keyof ProxiedBrowserProxyEvents>(
    event: E,
    listener: ProxiedBrowserProxyEvents[E]
  ): { remove: () => void }
}

/** Null in a binary built before the module existed, and on Android. */
export const OrcaProxiedBrowser =
  requireOptionalNativeModule<OrcaProxiedBrowserModule>('OrcaProxiedBrowser')

export type ProxiedBrowserNavigationState = {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  progress: number
  error?: string
}

export type OrcaProxiedBrowserViewProps = ViewProps & {
  /** The startProxy key whose proxy carries this view's traffic; the view waits until it is running. */
  proxyKey: string
  /** UUID naming the cookie and storage jar, so sign-ins persist per host. */
  storeId: string
  url: string
  /** Read when the view mounts: true loads on the phone's own network and ignores proxyKey. */
  direct?: boolean
  /** Read when the view mounts: true asks pages for their desktop layout. */
  desktopSite?: boolean
  onNavigationState?: (event: NativeSyntheticEvent<ProxiedBrowserNavigationState>) => void
}

export type OrcaProxiedBrowserViewHandle = {
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  reload: () => Promise<void>
  stopLoading: () => Promise<void>
}

let view: ComponentType<
  OrcaProxiedBrowserViewProps & RefAttributes<OrcaProxiedBrowserViewHandle>
> | null = null

// Resolve lazily: requiring a view manager the binary lacks throws.
export function orcaProxiedBrowserView(): ComponentType<
  OrcaProxiedBrowserViewProps & RefAttributes<OrcaProxiedBrowserViewHandle>
> {
  view ??= requireNativeViewManager<
    OrcaProxiedBrowserViewProps & RefAttributes<OrcaProxiedBrowserViewHandle>
  >('OrcaProxiedBrowser')
  return view
}
