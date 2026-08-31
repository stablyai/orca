import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISABLED_CHROMIUM_FEATURES } from '../startup/disabled-chromium-features'
import { runBrowserRouteEgressElectron } from './browser-route-egress-electron-launch'
import { browserRouteH3EgressElectronMain } from './browser-route-h3-egress-electron-main'

const PROBE_HOST = '127.0.0.1'

export type BrowserRouteH3EgressProbeResult = {
  resolvedProxy: string
  webTransport: string
  webTransportPackets: number
  directSockets: { tcp: string; udp: string; server: string }
  directSocketsConstruct: string
  rendererGone: string
  forcedQuic: string
  forcedQuicPackets: number
}

export async function runBrowserRouteH3EgressProbe(
  protectedSession: boolean
): Promise<BrowserRouteH3EgressProbeResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-browser-h3-egress-'))
  const webTransportObserver = createSocket('udp4')
  const forcedQuicObserver = createSocket('udp4')
  const sockets = new Set<Socket>()
  const socks = createSocksStandIn()
  let result: BrowserRouteH3EgressProbeResult | null = null
  let primaryFailure: unknown = null
  try {
    const [webTransportPort, forcedQuicPort, socksPort] = await Promise.all([
      bindUdp(webTransportObserver),
      bindUdp(forcedQuicObserver),
      listen(socks, sockets)
    ])
    const resultPath = join(root, 'result.json')
    const mainPath = join(root, 'main.cjs')
    writeFileSync(mainPath, browserRouteH3EgressElectronMain())
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        forcedQuicPort,
        host: PROBE_HOST,
        protectedSession,
        resultPath,
        socksPort,
        webTransportPort
      })
    )
    const parsed = await runBrowserRouteEgressElectron(
      root,
      mainPath,
      electronArgs(protectedSession, forcedQuicPort)
    )
    result = {
      ...readProbeFields(parsed),
      webTransportPackets: countOf(webTransportObserver),
      forcedQuicPackets: countOf(forcedQuicObserver)
    }
  } catch (error) {
    primaryFailure = error
  }
  const cleanupFailures = await cleanup(
    root,
    [webTransportObserver, forcedQuicObserver],
    socks,
    sockets
  )
  if (primaryFailure || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures],
      primaryFailure instanceof Error ? primaryFailure.message : 'browser_route_h3_probe_failed'
    )
  }
  if (!result) {
    throw new Error('browser_route_h3_probe_result_missing')
  }
  return result
}

const DIRECT_SOCKETS_FEATURES = [
  'DirectSockets',
  'DirectSocketsInSharedWorkers',
  'DirectSocketsInServiceWorkers'
]

function electronArgs(protectedSession: boolean, forcedQuicPort: number): string[] {
  const args = [
    `--origin-to-force-quic-on=${PROBE_HOST}:${forcedQuicPort}`,
    // Why: both arms opt Direct Sockets in so the control shows an exposed constructor; the guest arm then has to
    // beat an explicit enable, which is the future-Chromium-default-flip this switch exists to survive.
    `--enable-features=${DIRECT_SOCKETS_FEATURES.join(',')}`
  ]
  if (protectedSession) {
    // Why: the guest arm launches with the exact list Orca ships, so this proves the shipped switch, not a bare flag.
    args.push(`--disable-features=${DISABLED_CHROMIUM_FEATURES.join(',')}`)
  }
  return args
}

function readProbeFields(
  parsed: Record<string, unknown>
): Omit<BrowserRouteH3EgressProbeResult, 'webTransportPackets' | 'forcedQuicPackets'> {
  const { resolvedProxy, webTransport, directSockets, forcedQuic } = parsed
  const { directSocketsConstruct, rendererGone } = parsed
  if (
    typeof resolvedProxy !== 'string' ||
    typeof webTransport !== 'string' ||
    typeof directSockets !== 'string' ||
    typeof forcedQuic !== 'string' ||
    typeof directSocketsConstruct !== 'string' ||
    typeof rendererGone !== 'string'
  ) {
    throw new Error(`browser_route_h3_probe_result_invalid:${JSON.stringify(parsed)}`)
  }
  return {
    resolvedProxy,
    webTransport,
    forcedQuic,
    directSocketsConstruct,
    rendererGone,
    directSockets: JSON.parse(directSockets) as BrowserRouteH3EgressProbeResult['directSockets']
  }
}

const packetCounts = new WeakMap<UdpSocket, number>()

function countOf(socket: UdpSocket): number {
  return packetCounts.get(socket) ?? 0
}

function bindUdp(socket: UdpSocket): Promise<number> {
  socket.on('message', () => packetCounts.set(socket, countOf(socket) + 1))
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, PROBE_HOST, () => {
      socket.off('error', reject)
      resolve(socket.address().port)
    })
  })
}

function createSocksStandIn(): Server {
  // Why: the probes only need the endpoint to exist and verify as the resolved proxy; no SOCKS reply is negotiated.
  return createServer((socket) => socket.destroy())
}

function listen(server: Server, sockets: Set<Socket>): Promise<number> {
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, PROBE_HOST, () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('browser_route_h3_probe_listener_unavailable'))
        return
      }
      resolve(address.port)
    })
  })
}

async function cleanup(
  root: string,
  observers: UdpSocket[],
  socks: Server,
  sockets: Set<Socket>
): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  for (const observer of observers) {
    try {
      await closeUdp(observer)
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    await new Promise<void>((resolve, reject) =>
      socks.close((error) => (error ? reject(error) : resolve()))
    )
  } catch (error) {
    failures.push(error)
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    failures.push(error)
  }
  return failures
}

function closeUdp(socket: UdpSocket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve())
    } catch {
      resolve()
    }
  })
}
