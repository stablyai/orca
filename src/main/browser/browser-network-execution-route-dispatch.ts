import {
  resolveNativeBrowserNetworkExecutionRoute,
  type BrowserNetworkExecutionRouteResolver
} from './browser-network-execution-route'

// Keep SSH imports lazy and use the registry: ipc/ssh would pull Electron into the plain-Node runtime.
export const resolveBrowserNetworkExecutionRoute: BrowserNetworkExecutionRouteResolver = async (
  context
) => {
  if (context.executionHost.kind === 'native') {
    return resolveNativeBrowserNetworkExecutionRoute(context)
  }
  if (context.executionHost.kind === 'wsl') {
    const wslRoute = await import('./wsl-browser-network-execution-route')
    return wslRoute.resolveWslBrowserNetworkExecutionRoute(context)
  }
  const [{ getSshConnectionManager }, authority, sshRoute] = await Promise.all([
    import('../ssh/targets/ssh-target-registry'),
    import('../ssh/ssh-provider-authority'),
    import('./ssh-browser-network-execution-route')
  ])
  const connectionManager = getSshConnectionManager()
  if (!connectionManager) {
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  return sshRoute.resolveSshBrowserNetworkExecutionRoute(context, {
    connectionManager,
    isCurrentAuthority: authority.isCurrentSshProviderAuthority,
    registerAuthorityAbort: authority.registerSshProviderRequestAbort
  })
}
