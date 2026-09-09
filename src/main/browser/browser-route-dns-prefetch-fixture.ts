import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBrowserRouteEgressElectron } from './browser-route-egress-electron-launch'
import { browserRouteDnsPrefetchElectronMain } from './browser-route-dns-prefetch-electron-main'

export type BrowserRouteDnsPrefetchProbeResult = {
  resolvedProxy: string
  probeHost: string
  controlHost: string
  /** Names of the netLog event types that carried the prefetched host, e.g. HOST_RESOLVER_MANAGER_JOB. */
  probeHostResolverEvents: string[]
  /** Same lookup for a host the page never references, so an over-matching parser cannot pass. */
  controlHostResolverEvents: string[]
}

export async function runBrowserRouteDnsPrefetchProbe(): Promise<BrowserRouteDnsPrefetchProbeResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-browser-dns-prefetch-'))
  const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  const probeHost = `orca-prefetch-${unique}.invalid`
  const controlHost = `orca-control-${unique}.invalid`
  const sockets = new Set<Socket>()
  const socks = createServer((socket) => socket.destroy())
  let result: BrowserRouteDnsPrefetchProbeResult | null = null
  let primaryFailure: unknown = null
  try {
    const socksPort = await listen(socks, sockets)
    const netLogPath = join(root, 'netlog.json')
    const resultPath = join(root, 'result.json')
    const mainPath = join(root, 'main.cjs')
    writeFileSync(mainPath, browserRouteDnsPrefetchElectronMain())
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ netLogPath, probeHost, resultPath, socksPort })
    )
    const parsed = await runBrowserRouteEgressElectron(root, mainPath)
    if (typeof parsed.resolvedProxy !== 'string') {
      throw new Error(`browser_route_dns_prefetch_result_invalid:${JSON.stringify(parsed)}`)
    }
    const netLog = readFileSync(netLogPath, 'utf8')
    result = {
      resolvedProxy: parsed.resolvedProxy,
      probeHost,
      controlHost,
      probeHostResolverEvents: findHostResolverEvents(netLog, probeHost),
      controlHostResolverEvents: findHostResolverEvents(netLog, controlHost)
    }
  } catch (error) {
    primaryFailure = error
  }
  const cleanupFailures = await cleanup(root, socks, sockets)
  if (primaryFailure || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures],
      primaryFailure instanceof Error
        ? primaryFailure.message
        : 'browser_route_dns_prefetch_probe_failed'
    )
  }
  if (!result) {
    throw new Error('browser_route_dns_prefetch_probe_result_missing')
  }
  return result
}

type NetLog = {
  constants?: { logEventTypes?: Record<string, number>; logSourceType?: Record<string, number> }
  events?: { type?: number; source?: { type?: number; id?: number }; params?: unknown }[]
}

/**
 * Chromium names the resolved host only on the source-creating event, so collect the netLog source ids that
 * mention the host and report every HOST_RESOLVER event type recorded against them.
 */
function findHostResolverEvents(netLog: string, host: string): string[] {
  const parsed = parseNetLog(netLog)
  const eventTypeNames = invert(parsed.constants?.logEventTypes ?? {})
  const events = parsed.events ?? []
  const hostSourceIds = new Set<number>()
  for (const event of events) {
    const sourceId = event.source?.id
    if (sourceId !== undefined && JSON.stringify(event.params ?? null).includes(host)) {
      hostSourceIds.add(sourceId)
    }
  }
  const names = new Set<string>()
  for (const event of events) {
    const sourceId = event.source?.id
    if (sourceId === undefined || !hostSourceIds.has(sourceId) || event.type === undefined) {
      continue
    }
    const name = eventTypeNames.get(event.type)
    if (name?.startsWith('HOST_RESOLVER')) {
      names.add(name)
    }
  }
  return [...names].sort()
}

function parseNetLog(netLog: string): NetLog {
  try {
    return JSON.parse(netLog) as NetLog
  } catch {
    // Why: Electron writes the events array incrementally, so a run cut short leaves the trailing bracket off.
    return JSON.parse(`${netLog.replace(/,\s*$/, '')}]}`) as NetLog
  }
}

function invert(record: Record<string, number>): Map<number, string> {
  return new Map(Object.entries(record).map(([name, id]) => [id, name]))
}

function listen(server: Server, sockets: Set<Socket>): Promise<number> {
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('browser_route_dns_prefetch_listener_unavailable'))
        return
      }
      resolve(address.port)
    })
  })
}

async function cleanup(root: string, socks: Server, sockets: Set<Socket>): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
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
