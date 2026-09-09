import {
  resolveNativeBrowserNetworkExecutionRoute,
  type BrowserNetworkExecutionRouteResolver
} from './browser-network-execution-route'

/**
 * Dispatches an execution-host descriptor to its transport-specific route
 * resolver. Shared by the runtime tunnel RPC (paired remote clients) and the
 * local direct-SSH browser route, which dials the same resolvers in-process.
 * Imports stay dynamic so the SSH stack loads only when an SSH host is used, and the
 * connection manager comes from the registry rather than `ipc/ssh` — the runtime bundles
 * this module, and `ipc/ssh` would drag Electron into a graph that must boot on plain Node.
 */
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
    import('../ssh/ssh-target-registry'),
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
