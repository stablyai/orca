import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, type Server, Socket } from 'node:net'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistedWorkerElectronMain } from './browser-route-persisted-worker-electron-main'
import { runPersistedWorkerElectron } from './browser-route-persisted-worker-electron-process'

export type PersistedWorkerProbeResult = {
  workerRunningBeforeForcedWake: boolean
  preProxyWorkerRequests: number
  postProxyWorkerRequests: number
  directWorkerStartRequests: number
  directWorkerAfterProxyRequests: number
  socksWorkerStartRequests: number
  socksWorkerAfterProxyRequests: number
  resolvedProxy: string
}

type ProbeCounts = Omit<
  PersistedWorkerProbeResult,
  'workerRunningBeforeForcedWake' | 'resolvedProxy'
>

type TargetObservation = Readonly<{ path: string; remotePort: number }>

export async function runPersistedWorkerProbe(
  protectedSession: boolean
): Promise<PersistedWorkerProbeResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-browser-worker-egress-'))
  const observations: TargetObservation[] = []
  const routedSourcePorts = new Set<number>()
  const sockets = new Set<Socket>()
  const target = createTargetServer(observations)
  trackAcceptedSockets(target, sockets)
  let socks: Server | null = null
  let result: PersistedWorkerProbeResult | null = null
  let primaryFailure: { error: unknown } | null = null
  try {
    const targetPort = await listen(target)
    socks = createSocksRecorder(targetPort, routedSourcePorts, sockets)
    const socksPort = await listen(socks)
    const mainPath = join(root, 'main.cjs')
    const configPath = join(root, 'config.json')
    const resultPath = join(root, 'result.json')
    const workerStartedPath = join(root, 'worker-started')
    const continuePath = join(root, 'continue')
    writeFileSync(mainPath, persistedWorkerElectronMain())
    writeFileSync(
      configPath,
      JSON.stringify({
        continuePath,
        protectedSession,
        resultPath,
        socksPort,
        targetPort,
        workerStartedPath
      })
    )
    await runPersistedWorkerElectron(root, mainPath, configPath, 'setup')
    observations.length = 0
    routedSourcePorts.clear()
    const probe = await runPersistedWorkerElectron(
      root,
      mainPath,
      configPath,
      'probe',
      async () => {
        await waitFor(() => existsSync(workerStartedPath), 'worker_probe_start_barrier_missing')
        await waitFor(
          () => observations.some((observation) => observation.path === '/worker-start'),
          'worker_probe_control_fetch_missing'
        )
        writeFileSync(continuePath, '')
      }
    )
    result = { ...classifyProbeRequests(observations, routedSourcePorts), ...probe }
  } catch (error) {
    primaryFailure = { error }
  }
  const cleanupFailures = await cleanupProbeResources(root, target, socks, sockets)
  if (primaryFailure) {
    if (cleanupFailures.length > 0) {
      const message =
        primaryFailure.error instanceof Error
          ? primaryFailure.error.message
          : String(primaryFailure.error)
      throw new AggregateError([primaryFailure.error, ...cleanupFailures], message)
    }
    throw primaryFailure.error
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'worker_probe_cleanup_failed')
  }
  if (!result) {
    throw new Error('worker_probe_result_missing')
  }
  return result
}

async function cleanupProbeResources(
  root: string,
  target: Server,
  socks: Server | null,
  sockets: Set<Socket>
): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const server of socks ? [socks, target] : [target]) {
    try {
      await closeServer(server, sockets)
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    failures.push(error)
  }
  return failures
}

function createProbeCounts(): ProbeCounts {
  return {
    preProxyWorkerRequests: 0,
    postProxyWorkerRequests: 0,
    directWorkerStartRequests: 0,
    directWorkerAfterProxyRequests: 0,
    socksWorkerStartRequests: 0,
    socksWorkerAfterProxyRequests: 0
  }
}

function classifyProbeRequests(
  observations: TargetObservation[],
  routedSourcePorts: Set<number>
): ProbeCounts {
  const counts = createProbeCounts()
  for (const observation of observations) {
    const routed = routedSourcePorts.has(observation.remotePort)
    if (observation.path === '/worker-start') {
      counts.preProxyWorkerRequests += 1
      counts[routed ? 'socksWorkerStartRequests' : 'directWorkerStartRequests'] += 1
    }
    if (observation.path === '/worker-after-proxy') {
      counts.postProxyWorkerRequests += 1
      counts[routed ? 'socksWorkerAfterProxyRequests' : 'directWorkerAfterProxyRequests'] += 1
    }
  }
  return counts
}

function createTargetServer(observations: TargetObservation[]): Server {
  return createHttpServer((request, response) => {
    observations.push({ path: request.url ?? '', remotePort: request.socket.remotePort ?? -1 })
    if (request.url === '/sw.js') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/javascript',
        'Service-Worker-Allowed': '/'
      })
      response.end(workerScript())
      return
    }
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>worker probe</title>')
  })
}

function workerScript(): string {
  return [
    "fetch('/worker-start').catch(() => {})",
    "self.addEventListener('install', event => event.waitUntil(fetch('/worker-start').then(() => self.skipWaiting())))",
    "self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))",
    "self.addEventListener('message', event => {",
    "  if (event.data !== 'probe') return",
    "  event.waitUntil(fetch('/worker-after-proxy').then(() => event.source.postMessage('done')))",
    '})'
  ].join(';')
}

function createSocksRecorder(
  targetPort: number,
  routedSourcePorts: Set<number>,
  sockets: Set<Socket>
): Server {
  return createNetServer((client) => {
    trackSocket(client, sockets)
    let buffer = Buffer.alloc(0)
    let greeted = false
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (!greeted) {
        if (buffer.length < 2) {
          return
        }
        const greetingLength = 2 + (buffer[1] ?? 0)
        if (buffer.length < greetingLength) {
          return
        }
        buffer = buffer.subarray(greetingLength)
        greeted = true
        client.write(Buffer.from([5, 0]))
      }
      if (buffer.length < 4) {
        return
      }
      if (buffer[3] === 3 && buffer.length < 5) {
        return
      }
      const addressLength = buffer[3] === 1 ? 4 : buffer[3] === 4 ? 16 : (buffer[4] ?? 0) + 1
      const requestLength = 4 + addressLength + 2
      if (buffer.length < requestLength) {
        return
      }
      const remainder = buffer.subarray(requestLength)
      client.off('data', onData)
      connectSocksUpstream(client, remainder, targetPort, routedSourcePorts, sockets)
    }
    client.on('data', onData)
  })
}

function connectSocksUpstream(
  client: Socket,
  remainder: Buffer,
  targetPort: number,
  routedSourcePorts: Set<number>,
  sockets: Set<Socket>
): void {
  const upstream = new Socket()
  trackSocket(upstream, sockets)
  upstream.connect(targetPort, '127.0.0.1', () => {
    routedSourcePorts.add(upstream.localPort ?? -1)
    client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
    if (remainder.length > 0) {
      upstream.write(remainder)
    }
    client.pipe(upstream).pipe(client)
  })
  upstream.on('error', () => client.destroy())
  client.on('error', () => upstream.destroy())
  client.once('close', () => upstream.destroy())
}

function trackAcceptedSockets(server: Server, sockets: Set<Socket>): void {
  server.on('connection', (socket) => trackSocket(socket, sockets))
}

function trackSocket(socket: Socket, sockets: Set<Socket>): void {
  sockets.add(socket)
  socket.on('error', () => socket.destroy())
  socket.once('close', () => sockets.delete(socket))
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('worker_probe_listener_unavailable'))
        return
      }
      resolve(address.port)
    })
  })
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy()
  }
  if (!server.listening) {
    return Promise.resolve()
  }
  return new Promise((resolve) => server.close(() => resolve()))
}

function waitFor(predicate: () => boolean, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const check = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(code))
        return
      }
      setTimeout(check, 20)
    }
    check()
  })
}
