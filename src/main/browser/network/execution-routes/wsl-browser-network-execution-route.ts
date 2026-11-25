import { spawnProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import {
  launchBrowserNetworkRelay,
  type BrowserNetworkRelayChild,
  type BrowserNetworkRelayHost
} from './browser-network-relay-launch'
import { attachBrowserNetworkRelayTunnel } from './browser-network-relay-tunnel'
import './browser-network-execution-route'
import { browserNetworkExecutionHostKey } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import { WSL_BROWSER_NETWORK_RELAY_DIR } from '../../../../shared/browser/network/tunnels/wsl-browser-network-relay-contract'
import type {
  BrowserNetworkExecutionRoute,
  BrowserNetworkExecutionRouteContext
} from './browser-network-execution-route-contract'

type WslBrowserNetworkExecutionRouteDependencies = {
  launchRelay?: (distro: string, signal: AbortSignal) => Promise<BrowserNetworkRelayChild>
}

export async function resolveWslBrowserNetworkExecutionRoute(
  context: BrowserNetworkExecutionRouteContext,
  dependencies: WslBrowserNetworkExecutionRouteDependencies = {}
): Promise<BrowserNetworkExecutionRoute> {
  const host = context.executionHost
  if (
    host.kind !== 'wsl' ||
    host.runtimeId !== context.runtimeId ||
    host.revision !== context.runtimeRevision
  ) {
    throw new Error('browser_tunnel_execution_host_mismatch')
  }
  if (context.signal?.aborted) {
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  const routeAbort = new AbortController()
  const abortRoute = (): void => routeAbort.abort()
  context.signal?.addEventListener('abort', abortRoute, { once: true })
  const launchRelay = dependencies.launchRelay ?? launchWslBrowserNetworkRelay
  let child: BrowserNetworkRelayChild
  try {
    child = await launchRelay(host.distro, routeAbort.signal)
  } catch (error) {
    context.signal?.removeEventListener('abort', abortRoute)
    throw error
  }
  const tunnel = attachBrowserNetworkRelayTunnel(child, routeAbort.signal)
  void tunnel.whenInvalidated.then(() => {
    context.signal?.removeEventListener('abort', abortRoute)
    routeAbort.abort()
  })
  return {
    key: browserNetworkExecutionHostKey(host),
    connect: tunnel.connect,
    whenInvalidated: tunnel.whenInvalidated,
    isValid: tunnel.isValid,
    close: tunnel.close
  }
}

function launchWslBrowserNetworkRelay(
  distro: string,
  signal: AbortSignal
): Promise<BrowserNetworkRelayChild> {
  const relayHost: BrowserNetworkRelayHost = {
    homeDir: WSL_BROWSER_NETWORK_RELAY_DIR,
    run: async (command) => {
      // spawnProcess pipes all three streams, so the relay child has no null streams.
      const child: BrowserNetworkRelayChild = spawnProcess({
        program: windowsSystem32Binary('wsl.exe'),
        args: ['-d', distro, '--exec', 'sh', '-c', command],
        stdio: 'pipe',
        env: { ...process.env, WSL_UTF8: '1' }
      })
      return child
    }
  }
  return launchBrowserNetworkRelay(relayHost, signal)
}
