import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { loadBrowserDrawing, type MobileLocalBrowserNetwork } from '../storage/preferences'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileBrowserViewMode } from './browser-screencast-request'
import { PHONE_NETWORK_BROWSER_STORE_ID } from './mobile-browser-local-proxy'
import { MobileLocalBrowserPane } from './MobileLocalBrowserPane'
import { useMobileBrowserLocalTunnel } from './use-mobile-browser-local-tunnel'

type Props = {
  client: RpcClient | null
  hostId: string
  worktreeId: string
  initialUrl: string
  // Read from the browser settings when absent; a tab set to stream that asks to be drawn goes through the host.
  initialNetwork?: MobileLocalBrowserNetwork
  initialViewMode: MobileBrowserViewMode
  onViewModeChange?: (mode: MobileBrowserViewMode) => void
  onNetworkChange?: (network: MobileLocalBrowserNetwork) => void
  fullScreen: ComponentProps<typeof MobileLocalBrowserPane>['fullScreen']
  // Shown until the saved network is read and, through the host, until the tunnel is up.
  pending: ReactNode
  onStreamFromHost: () => void
  // The tunnel through the host failed; the phone's network still works.
  onHostTunnelFailed: (reason: string) => void
  onUrlChange?: (url: string) => void
  onToast: (message: string, durationMs?: number) => void
}

/** A phone-drawn tab on the network the browser settings pick; the toolbar can switch it for this tab. */
export function MobileLocalBrowser({
  client,
  hostId,
  worktreeId,
  initialUrl,
  initialNetwork,
  initialViewMode,
  onViewModeChange,
  onNetworkChange,
  fullScreen,
  pending,
  onStreamFromHost,
  onHostTunnelFailed,
  onUrlChange,
  onToast
}: Props): React.JSX.Element {
  const [network, setNetwork] = useState<MobileLocalBrowserNetwork | null>(initialNetwork ?? null)
  const [viewMode, setViewMode] = useState(initialViewMode)
  // Switching network or layout remounts the web view, which then reopens the page it was on.
  const currentUrl = useRef(initialUrl)
  const [resumeUrl, setResumeUrl] = useState(initialUrl)
  const local = useMobileBrowserLocalTunnel(client, hostId, worktreeId, network === 'host')

  useEffect(() => {
    if (initialNetwork) {
      return
    }
    let active = true
    void loadBrowserDrawing().then((saved) => {
      if (active) {
        setNetwork((current) => current ?? (saved === 'phone' ? 'phone' : 'host'))
      }
    })
    return () => {
      active = false
    }
  }, [initialNetwork])

  const failure = network === 'host' && local.status === 'failed' ? local.message : null
  useEffect(() => {
    if (failure !== null) {
      onHostTunnelFailed(failure)
    }
  }, [failure, onHostTunnelFailed])

  if (network === null) {
    return <>{pending}</>
  }
  const ready =
    network === 'phone'
      ? { proxyKey: '', storeId: PHONE_NETWORK_BROWSER_STORE_ID }
      : local.status === 'ready'
        ? local
        : null
  if (!ready) {
    return <>{pending}</>
  }
  return (
    <MobileLocalBrowserPane
      key={`${network}:${viewMode}`}
      network={network}
      proxyKey={ready.proxyKey}
      storeId={ready.storeId}
      initialUrl={resumeUrl}
      viewMode={viewMode}
      onViewModeChange={(next) => {
        if (next === viewMode) {
          return
        }
        setResumeUrl(currentUrl.current)
        setViewMode(next)
        onViewModeChange?.(next)
      }}
      fullScreen={fullScreen}
      onStreamFromHost={onStreamFromHost}
      onNetworkChange={(next) => {
        if (next === network) {
          return
        }
        setResumeUrl(currentUrl.current)
        setNetwork(next)
        onNetworkChange?.(next)
      }}
      onUrlChange={(url) => {
        currentUrl.current = url
        onUrlChange?.(url)
      }}
      onToast={onToast}
    />
  )
}
