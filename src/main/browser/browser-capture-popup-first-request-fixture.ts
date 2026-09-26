import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBrowserRouteEgressElectron } from './browser-route-egress-electron-launch'
import { browserCapturePopupFirstRequestElectronMain } from './browser-capture-popup-first-request-electron-main'

export type BrowserCapturePopupFirstRequestProbe = {
  /** Full response URLs the popup debugger hook recorded. */
  capturedUrls: { url: string; status: number; type?: string }[]
  /** How many times the local server saw the popup's first navigation. */
  healthzHits: number
}

export async function runBrowserCapturePopupFirstRequestProbe(): Promise<BrowserCapturePopupFirstRequestProbe> {
  const root = mkdtempSync(join(tmpdir(), 'orca-browser-popup-capture-'))
  const sockets = new Set<Socket>()
  let healthzHits = 0
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/healthz')) {
      healthzHits += 1
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    if (req.url === '/opener') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<!doctype html><title>opener</title><script>window.open("/healthz?probe=1")</script>'
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  let result: BrowserCapturePopupFirstRequestProbe | null = null
  let primaryFailure: unknown = null
  const previousBackgroundLaunch = process.env.ORCA_BACKGROUND_LAUNCH
  try {
    const port = await listen(server, sockets)
    process.env.ORCA_BACKGROUND_LAUNCH = '1'
    const resultPath = join(root, 'result.json')
    writeFileSync(join(root, 'main.cjs'), browserCapturePopupFirstRequestElectronMain())
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ resultPath, openerUrl: `http://127.0.0.1:${port}/opener` })
    )
    const parsed = await runBrowserRouteEgressElectron(root, join(root, 'main.cjs'))
    result = { capturedUrls: parseCapturedUrls(parsed.captured), healthzHits }
  } catch (error) {
    primaryFailure = error
  } finally {
    if (previousBackgroundLaunch === undefined) {
      delete process.env.ORCA_BACKGROUND_LAUNCH
    } else {
      process.env.ORCA_BACKGROUND_LAUNCH = previousBackgroundLaunch
    }
  }
  const cleanupFailures = await cleanup(root, server, sockets)
  if (primaryFailure || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures],
      primaryFailure instanceof Error
        ? primaryFailure.message
        : 'browser_capture_popup_first_request_failed'
    )
  }
  if (!result) {
    throw new Error('browser_capture_popup_first_request_missing')
  }
  return result
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseCapturedUrls(raw: unknown): BrowserCapturePopupFirstRequestProbe['capturedUrls'] {
  if (!Array.isArray(raw)) {
    throw new Error(`browser_capture_popup_result_invalid:${JSON.stringify(raw)}`)
  }
  return raw.map((item) => {
    if (!isStringRecord(item) || typeof item.url !== 'string' || typeof item.status !== 'number') {
      throw new Error(`browser_capture_popup_result_invalid:${JSON.stringify(item)}`)
    }
    return {
      url: item.url,
      status: item.status,
      ...(typeof item.type === 'string' ? { type: item.type } : {})
    }
  })
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
        reject(new Error('browser_capture_popup_listener_unavailable'))
        return
      }
      resolve(address.port)
    })
  })
}

async function cleanup(root: string, server: Server, sockets: Set<Socket>): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  try {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
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
