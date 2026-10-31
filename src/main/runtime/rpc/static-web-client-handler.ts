import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, posix, relative, resolve } from 'node:path'
import { readBundledWebClientFiles } from '../../../shared/bundled-web-client-manifest'

const STATIC_WEB_ALLOWED_PATHS = new Set(['/web-index.html'])
const STATIC_WEB_ALLOWED_PREFIXES = ['/assets/', '/cmaps/', '/standard_fonts/', '/wasm/']
const STATIC_WEB_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2']
])

/** A server without a web client still answers plain HTTP, so callers fail fast instead of hanging. */
export const answerWithoutWebClient: RequestListener = (_request, response) => {
  writeHttpStatus(response, 404)
}

export function createStaticWebClientHandler(staticRoot: string): RequestListener {
  const resolvedRoot = resolve(staticRoot)
  let files: ReadonlySet<string> | undefined
  try {
    files = readBundledWebClientFiles(resolvedRoot)
  } catch (error) {
    // Damaged web installs must not disable the runtime server.
    console.warn(`[ws-transport] browser client disabled: ${String(error)}`)
    return answerWithoutWebClient
  }
  if (basename(resolvedRoot) === 'renderer' && !files) {
    return answerWithoutWebClient
  }
  return (request, response) => {
    void handleStaticRequest(resolvedRoot, files, request, response)
  }
}

async function handleStaticRequest(
  staticRoot: string,
  files: ReadonlySet<string> | undefined,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (response.destroyed) {
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    writeHttpStatus(response, 405)
    return
  }

  const pathname = parseStaticPathname(request.url)
  if (!pathname) {
    writeHttpStatus(response, 400)
    return
  }
  if (!isAllowedStaticWebPath(pathname) || (files && !files.has(pathname.slice(1)))) {
    writeHttpStatus(response, 404)
    return
  }

  const absolutePath = resolve(staticRoot, pathname.slice(1))
  const relativePath = relative(staticRoot, absolutePath)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    writeHttpStatus(response, 404)
    return
  }

  let fileStat
  try {
    fileStat = await stat(absolutePath)
  } catch {
    writeHttpStatus(response, 404)
    return
  }
  if (response.destroyed) {
    return
  }
  if (!fileStat.isFile()) {
    writeHttpStatus(response, 404)
    return
  }

  response.statusCode = 200
  response.setHeader(
    'Content-Type',
    STATIC_WEB_CONTENT_TYPES.get(extname(absolutePath)) ?? 'application/octet-stream'
  )
  response.setHeader('Content-Length', fileStat.size)
  response.setHeader(
    'Cache-Control',
    pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  )
  if (request.method === 'HEAD') {
    response.end()
    return
  }

  const stream = createReadStream(absolutePath)
  const stopReading = (): void => {
    stream.destroy()
  }
  response.once('close', stopReading)
  response.once('error', stopReading)
  stream.once('close', () => {
    response.off('close', stopReading)
    response.off('error', stopReading)
  })
  stream.on('error', () => {
    if (response.destroyed) {
      return
    }
    if (!response.headersSent) {
      response.setHeader('Content-Length', 0)
      response.setHeader('Cache-Control', 'no-store')
      writeHttpStatus(response, 500)
      return
    }
    response.destroy()
  })
  stream.pipe(response)
}

function parseStaticPathname(rawUrl: string | undefined): string | null {
  if (!rawUrl) {
    return '/web-index.html'
  }
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname)
  } catch {
    return null
  }
  if (pathname === '/' || pathname === '/index.html') {
    return '/web-index.html'
  }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
    return null
  }
  if (posix.normalize(pathname) !== pathname) {
    return null
  }
  return mapProxyPrefixedStaticPathname(pathname)
}

function mapProxyPrefixedStaticPathname(pathname: string): string {
  if (pathname === '/web-index.html' || pathname.endsWith('/web-index.html')) {
    return '/web-index.html'
  }
  const prefixIndex = STATIC_WEB_ALLOWED_PREFIXES.reduce(
    (deepest, prefix) => Math.max(deepest, pathname.indexOf(prefix)),
    -1
  )
  if (prefixIndex !== -1) {
    // Proxies may forward an external prefix; serve only the bundled assets subtree after it.
    return pathname.slice(prefixIndex)
  }
  return pathname
}

function isAllowedStaticWebPath(pathname: string): boolean {
  return (
    STATIC_WEB_ALLOWED_PATHS.has(pathname) ||
    STATIC_WEB_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  )
}

function writeHttpStatus(response: ServerResponse, statusCode: number): void {
  if (response.destroyed) {
    return
  }
  response.statusCode = statusCode
  response.end()
}
