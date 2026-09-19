import { createHash } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from './browser-local-https-test-certificate'

export type WireProbeReceipt = Readonly<{
  protocol: 'http' | 'https' | 'ws' | 'wss'
  path: string
  userAgent: string | null
  clientHints: Readonly<Record<string, string>>
}>

export type WireProbeJavaScriptIdentity = Readonly<{
  context: string
  userAgent: string
  userAgentData: unknown
}>

export type BrowserSessionUaWireProbeServer = Readonly<{
  httpOrigin: string
  crossSiteOrigin: string
  httpsOrigin: string
  receipts: WireProbeReceipt[]
  identities: WireProbeJavaScriptIdentity[]
  close: () => Promise<void>
}>
function boundPort(server: { address: () => AddressInfo | string | null }): number {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('wire_probe_server_not_listening_on_tcp')
  }
  return address.port
}
export async function startBrowserSessionUaWireProbeServer(): Promise<BrowserSessionUaWireProbeServer> {
  const receipts: WireProbeReceipt[] = []
  const identities: WireProbeJavaScriptIdentity[] = []
  const upgradedSockets = new Set<Duplex>()
  let origins: { http: string; https: string } | null = null
  const respond =
    (protocol: 'http' | 'https') =>
    async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const path = new URL(request.url ?? '/', 'http://probe.invalid').pathname
      receipts.push({
        protocol,
        path,
        userAgent:
          typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        clientHints: requestClientHints(request)
      })
      if (path.startsWith('/report/')) {
        const body = await readBody(request)
        identities.push({ context: path.slice('/report/'.length), ...JSON.parse(body) })
        respondText(response, 'ok')
        return
      }
      if (path === '/shared-worker.js') {
        respondScript(response, sharedWorkerScript(origins?.http ?? ''))
        return
      }
      if (path === '/service-worker.js') {
        response.setHeader('Service-Worker-Allowed', '/')
        respondScript(response, serviceWorkerScript(origins?.http ?? ''))
        return
      }
      if (path === '/frame') {
        respondHtml(response, childPage('frame', origins?.http ?? ''))
        return
      }
      if (path === '/cross-site-frame') {
        respondHtml(
          response,
          childPage('cross-site-frame', origins?.http ?? '', false, origins?.https ?? '')
        )
        return
      }
      if (path === '/dedicated-worker.js') {
        respondScript(response, dedicatedWorkerScript(origins?.http ?? ''))
        return
      }
      if (path === '/popup') {
        respondHtml(response, childPage('popup', origins?.http ?? '', true))
        return
      }
      if (path === '/desktop-peer') {
        respondHtml(response, desktopPeerPage(origins?.http ?? ''))
        return
      }
      if (path.endsWith('-image')) {
        response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'image/gif' })
        response.end(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'))
        return
      }
      if (path === '/') {
        respondHtml(
          response,
          probePage(
            origins?.http ?? '',
            origins?.https ?? '',
            origins?.https ?? '',
            new URL(request.url ?? '/', 'http://probe.invalid').searchParams.get(
              'cross-context'
            ) === '1'
          )
        )
        return
      }
      respondText(response, path)
    }
  const http = createHttpServer((request, response) => void respond('http')(request, response))
  const https = createHttpsServer(
    { cert: LOCAL_HTTPS_TEST_CERTIFICATE, key: LOCAL_HTTPS_TEST_PRIVATE_KEY },
    (request, response) => void respond('https')(request, response)
  )
  installWebSocketResponder(http, 'ws', receipts, upgradedSockets)
  installWebSocketResponder(https, 'wss', receipts, upgradedSockets)
  await Promise.all([listen(http), listen(https)])
  origins = {
    http: `http://127.0.0.1:${boundPort(http)}`,
    https: `https://127.0.0.1:${boundPort(https)}`
  }
  return {
    httpOrigin: origins.http,
    crossSiteOrigin: origins.https,
    httpsOrigin: origins.https,
    receipts,
    identities,
    close: async () => {
      for (const socket of upgradedSockets) {
        socket.destroy()
      }
      await Promise.all([closeServer(http), closeServer(https)])
    }
  }
}
function probePage(
  httpOrigin: string,
  httpsOrigin: string,
  crossSiteOrigin: string,
  crossContext: boolean
): string {
  const blobScript = contextScript('blob', httpOrigin, ['/blob-fetch', '/blob-xhr', '/blob-image'])
  const blobDocument = `<!doctype html><script>${blobScript}</script>`
  const serializedBlobDocument = JSON.stringify(blobDocument).replace('</script>', '<\\/script>')
  const crossSiteFrameScript = crossContext
    ? `const crossSiteFrame = document.createElement('iframe'); crossSiteFrame.src = ${JSON.stringify(crossSiteOrigin)} + '/cross-site-frame'; document.body.append(crossSiteFrame)`
    : ''
  const dedicatedWorkerScriptText = crossContext
    ? `const dedicatedDone = message('dedicated-worker'); const dedicated = new Worker(${JSON.stringify(httpOrigin)} + '/dedicated-worker.js'); dedicated.onmessage = event => postMessage(event.data, '*')`
    : ''
  return `<!doctype html><title>UA wire probe</title><script>
  const identity = () => ({ userAgent: navigator.userAgent, userAgentData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null })
  const report = context => fetch(${JSON.stringify(httpOrigin)} + '/report/' + context, { method: 'POST', body: JSON.stringify(identity()) })
  const fetchRoute = path => fetch(${JSON.stringify(httpOrigin)} + path).then(response => response.text())
  const xhrRoute = path => new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('GET', ${JSON.stringify(httpOrigin)} + path); xhr.onload = resolve; xhr.onerror = reject; xhr.send() })
  const imageRoute = path => new Promise((resolve, reject) => { const image = new Image(); image.onload = resolve; image.onerror = reject; image.src = ${JSON.stringify(httpOrigin)} + path })
  const message = context => new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(context + ' timeout')), 10000); const listener = event => { if (event.data?.context !== context) return; clearTimeout(timeout); removeEventListener('message', listener); resolve(event.data) }; addEventListener('message', listener) })
  const socket = url => new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.onopen = () => { ws.close(); resolve() }; ws.onerror = reject })
  window.probePromise = (async () => {
    await report('document')
    const frameDone = message('frame'); const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(httpOrigin)} + '/frame'; document.body.append(frame)
    ${crossSiteFrameScript}
    const blobDone = message('blob'); const blob = document.createElement('iframe'); blob.src = URL.createObjectURL(new Blob([${serializedBlobDocument}], { type: 'text/html' })); document.body.append(blob)
    const sharedDone = message('shared-worker'); const shared = new SharedWorker(${JSON.stringify(httpOrigin)} + '/shared-worker.js'); shared.port.start(); shared.port.onmessage = event => postMessage(event.data, '*')
    ${dedicatedWorkerScriptText}
    const serviceDone = message('service-worker'); const registration = await navigator.serviceWorker.register('/service-worker.js'); await navigator.serviceWorker.ready; navigator.serviceWorker.addEventListener('message', event => postMessage(event.data, '*')); (navigator.serviceWorker.controller || registration.active).postMessage('probe')
    const popupDone = message('popup'); window.open(${JSON.stringify(httpOrigin)} + '/popup', '_blank')
    await Promise.all([
      fetchRoute('/document-fetch'), xhrRoute('/document-xhr'), imageRoute('/document-image'),
      socket('ws://' + new URL(${JSON.stringify(httpOrigin)}).host + '/plain-ws'),
      socket('wss://' + new URL(${JSON.stringify(httpsOrigin)}).host + '/secure-ws'),
      frameDone, blobDone, sharedDone${crossContext ? ', dedicatedDone' : ''}, serviceDone, popupDone
    ])
    return true
  })()
  </script>`
}
function childPage(
  context: string,
  httpOrigin: string,
  popup = false,
  fetchOrigin = httpOrigin
): string {
  const extra = popup ? `await fetch(${JSON.stringify(httpOrigin)} + '/popup-fetch')` : ''
  const crossSiteFetch =
    context === 'cross-site-frame'
      ? `await fetch(${JSON.stringify(fetchOrigin)} + '/cross-site-frame-fetch')`
      : ''
  return `<!doctype html><script>(async () => { const identity = { userAgent: navigator.userAgent, userAgentData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null }; await fetch(${JSON.stringify(httpOrigin)} + '/report/${context}', { method: 'POST', body: JSON.stringify(identity) }); ${extra} ${crossSiteFetch}; (opener || parent).postMessage({ context: '${context}' }, '*') })()</script>`
}

function desktopPeerPage(httpOrigin: string): string {
  return `<!doctype html><script>
  const identity = { userAgent: navigator.userAgent, userAgentData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null }
  window.peerProbePromise = (async () => {
    await fetch(${JSON.stringify(httpOrigin)} + '/report/desktop-peer', { method: 'POST', body: JSON.stringify(identity) })
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('desktop peer shared-worker timeout')), 10000)
      const shared = new SharedWorker(${JSON.stringify(httpOrigin)} + '/shared-worker.js')
      shared.port.start()
      shared.port.onmessage = () => { clearTimeout(timeout); resolve() }
    })
    return true
  })()
  </script>`
}
function contextScript(context: string, httpOrigin: string, routes: string[]): string {
  return `(async () => { const identity = { userAgent: navigator.userAgent, userAgentData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null }; await fetch(${JSON.stringify(httpOrigin)} + '/report/${context}', { method: 'POST', body: JSON.stringify(identity) }); await fetch(${JSON.stringify(httpOrigin + routes[0])}); await new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('GET', ${JSON.stringify(httpOrigin + routes[1])}); xhr.onload = resolve; xhr.onerror = reject; xhr.send() }); await new Promise((resolve, reject) => { const image = new Image(); image.onload = resolve; image.onerror = reject; image.src = ${JSON.stringify(httpOrigin + routes[2])} }); parent.postMessage({ context: '${context}' }, '*') })()`
}
function sharedWorkerScript(httpOrigin: string): string {
  return `onconnect = event => { const port = event.ports[0]; (async () => { const identity = { userAgent: navigator.userAgent, userAgentData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null }; await fetch(${JSON.stringify(httpOrigin)} + '/report/shared-worker', { method: 'POST', body: JSON.stringify(identity) }); await fetch(${JSON.stringify(httpOrigin)} + '/shared-worker-fetch-a'); await fetch(${JSON.stringify(httpOrigin)} + '/shared-worker-fetch-b'); port.postMessage({ context: 'shared-worker' }) })() }`
}
function dedicatedWorkerScript(httpOrigin: string): string {
  return `const identity = { userAgent: navigator.userAgent, userAgentData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null }; (async () => { await fetch(${JSON.stringify(httpOrigin)} + '/report/dedicated-worker', { method: 'POST', body: JSON.stringify(identity) }); await fetch(${JSON.stringify(httpOrigin)} + '/dedicated-worker-fetch'); postMessage({ context: 'dedicated-worker' }); })();`
}

function serviceWorkerScript(httpOrigin: string): string {
  return `addEventListener('install', event => event.waitUntil(skipWaiting())); addEventListener('activate', event => event.waitUntil(clients.claim())); addEventListener('message', event => { if (event.data !== 'probe') return; event.waitUntil((async () => { const identity = { userAgent: navigator.userAgent, userAgentData: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null }; await fetch(${JSON.stringify(httpOrigin)} + '/report/service-worker', { method: 'POST', body: JSON.stringify(identity) }); await fetch(${JSON.stringify(httpOrigin)} + '/service-worker-fetch'); event.source.postMessage({ context: 'service-worker' }) })()) })`
}

function installWebSocketResponder(
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>,
  protocol: 'ws' | 'wss',
  receipts: WireProbeReceipt[],
  upgradedSockets: Set<Duplex>
): void {
  server.on('upgrade', (request, socket) => {
    upgradedSockets.add(socket)
    socket.once('close', () => upgradedSockets.delete(socket))
    const key = request.headers['sec-websocket-key']
    receipts.push({
      protocol,
      path: new URL(request.url ?? '/', 'http://probe.invalid').pathname,
      userAgent:
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      clientHints: requestClientHints(request)
    })
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
  })
}

function listen(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.once('error', reject)
  })
}

function respondText(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
  response.end(body)
}

function requestClientHints(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([key, value]) =>
      key.toLowerCase().startsWith('sec-ch-ua') && typeof value === 'string'
        ? [[key.toLowerCase(), value]]
        : []
    )
  )
}

function respondHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' })
  response.end(body)
}

function respondScript(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/javascript'
  })
  response.end(body)
}
