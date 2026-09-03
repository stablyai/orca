import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBrowserRouteEgressElectron } from './browser-route-egress-electron-launch'
import { browserRouteWebrtcEgressElectronMain } from './browser-route-webrtc-egress-electron-main'

export type BrowserRouteWebrtcEgressProbeResult = {
  packets: number
  policy: string
  resolvedProxy: string
}

const fixtureRoots: string[] = []

export async function runBrowserRouteWebrtcEgressProbe(
  protectedGuest: boolean
): Promise<BrowserRouteWebrtcEgressProbeResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-browser-webrtc-egress-'))
  fixtureRoots.push(root)
  const mainPath = join(root, 'main.cjs')
  writeFileSync(mainPath, browserRouteWebrtcEgressElectronMain())
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ protectedGuest, resultPath: join(root, 'result.json') })
  )
  const parsed = await runBrowserRouteEgressElectron(root, mainPath)
  const { packets, policy, resolvedProxy } = parsed
  if (
    typeof packets !== 'number' ||
    typeof policy !== 'string' ||
    typeof resolvedProxy !== 'string'
  ) {
    throw new Error(`browser_route_webrtc_probe_result_invalid:${JSON.stringify(parsed)}`)
  }
  return { packets, policy, resolvedProxy }
}

export function cleanupBrowserRouteWebrtcEgressFixtures(): void {
  const failures: unknown[] = []
  for (const root of fixtureRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      failures.push(error)
    }
  }
  fixtureRoots.length = 0
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to clean up WebRTC egress fixtures')
  }
}
