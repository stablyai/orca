import { prefixRpcMethodGroup, type LazyRpcMethodGroup } from '../lazy-rpc-method-group'

export const LAZY_BROWSER_RPC_METHOD_GROUPS: readonly LazyRpcMethodGroup[] = [
  prefixRpcMethodGroup(
    ['browser.', 'desktopBrowserBridge.'],
    async () => {
      const [
        { BROWSER_CORE_METHODS },
        { BROWSER_IDENTITY_METHODS },
        { BROWSER_SCREENCAST_METHODS },
        { BROWSER_GRAB_METHODS },
        { BROWSER_EXTRA_METHODS },
        { BROWSER_CLIENT_HOST_METHODS },
        { DESKTOP_BROWSER_BRIDGE_RPC_METHODS },
        { BROWSER_CLIENT_FILE_CHANNEL_METHODS },
        { BROWSER_NETWORK_TUNNEL_METHODS }
      ] = await Promise.all([
        import('./browser/browser-core'),
        import('./browser/browser-identity-rpc'),
        import('./browser/browser-screencast'),
        import('./browser/browser-grab'),
        import('./browser/browser-extras'),
        import('./browser/browser-client-host'),
        import('./browser/desktop-browser-bridge'),
        import('./browser/browser-client-file-channel'),
        import('./browser/browser-network-tunnel')
      ])
      return [
        ...BROWSER_CORE_METHODS,
        ...BROWSER_IDENTITY_METHODS,
        ...BROWSER_SCREENCAST_METHODS,
        ...BROWSER_GRAB_METHODS,
        ...BROWSER_EXTRA_METHODS,
        ...BROWSER_CLIENT_HOST_METHODS,
        ...DESKTOP_BROWSER_BRIDGE_RPC_METHODS,
        ...BROWSER_CLIENT_FILE_CHANNEL_METHODS,
        ...BROWSER_NETWORK_TUNNEL_METHODS
      ]
    },
    {
      exactNames: ['network.browserTunnel'],
      streamingNames: [
        'browser.screencast',
        'browser.downloadCopyStream',
        'browser.grab.watch',
        'browser.clientHost.attach',
        'desktopBrowserBridge.attach',
        'network.browserTunnel'
      ]
    }
  )
]
