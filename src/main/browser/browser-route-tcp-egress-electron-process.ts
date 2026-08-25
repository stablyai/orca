import { runBrowserRouteEgressElectron } from './browser-route-egress-electron-launch'

export async function runBrowserRouteTcpEgressElectron(
  root: string,
  mainPath: string
): Promise<string> {
  const parsed = await runBrowserRouteEgressElectron(root, mainPath)
  if (typeof parsed.resolvedProxy !== 'string') {
    throw new Error('browser_route_tcp_probe_result_invalid')
  }
  return parsed.resolvedProxy
}
