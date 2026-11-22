import { createReadStream, type Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, posix, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, gzip } from 'node:zlib'
import { readBundledWebClientFiles } from '../../../../../shared/web-client/bundled-web-client-manifest'

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
const STATIC_WEB_COMPRESSIBLE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.svg',
  '.wasm'
])
// Why: gzip's wrapper plus a block header eats the saving on small bodies; the same floor as
// COMPRESSED_FRAME_MIN_BYTES in shared/remote-runtime/e2ee/paired-e2ee-compressed-frame.ts.
const STATIC_WEB_COMPRESS_MIN_BYTES = 1024
// Why: the bundled client ships a bounded asset set, but cache keys accept any on-disk file
// version; both caps keep a huge asset tree from growing memory unboundedly.
const STATIC_WEB_COMPRESSED_MAX_ENTRIES = 128
const STATIC_WEB_COMPRESSED_MAX_BYTES = 16 * 1024 * 1024

// Async so compression runs on the libuv pool, not the main process's event loop.
const brotliCompressAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

type StaticWebCompressedEntry = {
  promise: Promise<StaticWebCompressedVariant | null>
  // The source size stands in until the variant resolves (a kept variant is always smaller),
  // so in-flight compressions still count toward the byte cap.
  accountedBytes: number
  evicted: boolean
}
const staticWebCompressedCache = new Map<string, StaticWebCompressedEntry>()
let staticWebCompressedBytes = 0

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

  const extension = extname(absolutePath)
  const encoding =
    fileStat.size >= STATIC_WEB_COMPRESS_MIN_BYTES &&
    STATIC_WEB_COMPRESSIBLE_EXTENSIONS.has(extension)
      ? negotiatedStaticEncoding(request.headers['accept-encoding'])
      : undefined
  const variant = encoding ? await compressedStaticVariant(absolutePath, fileStat, encoding) : null
  if (response.destroyed) {
    return
  }

  response.statusCode = 200
  response.setHeader(
    'Content-Type',
    STATIC_WEB_CONTENT_TYPES.get(extension) ?? 'application/octet-stream'
  )
  // Why: every 200 answers identity, gzip or br from one URL, so caches must key on Accept-Encoding.
  response.setHeader('Vary', 'Accept-Encoding')
  response.setHeader(
    'Cache-Control',
    pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  )
  if (variant) {
    response.setHeader('Content-Encoding', variant.encoding)
    response.setHeader('Content-Length', variant.bytes.byteLength)
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    response.end(variant.bytes)
    return
  }
  response.setHeader('Content-Length', fileStat.size)
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

/** Picks br, then gzip, honoring q-values; `*` accepts either unless the coding opted out. */
function negotiatedStaticEncoding(
  header: string | string[] | undefined
): 'br' | 'gzip' | undefined {
  if (!header) {
    return undefined
  }
  const accepted = new Map<string, number>()
  for (const item of (Array.isArray(header) ? header.join(',') : header).split(',')) {
    const [coding, ...parameters] = item.split(';')
    const name = coding.trim().toLowerCase()
    if (!name) {
      continue
    }
    let quality = 1
    for (const parameter of parameters) {
      const [key, value] = parameter.split('=')
      if (key.trim().toLowerCase() === 'q') {
        // A malformed q reads as "not accepted", the safest reading of a client header.
        quality = Number(value) || 0
      }
    }
    accepted.set(name, Math.max(accepted.get(name) ?? 0, quality))
  }
  const allows = (encoding: 'br' | 'gzip'): boolean =>
    (accepted.get(encoding) ?? accepted.get('*') ?? 0) > 0
  if (allows('br')) {
    return 'br'
  }
  return allows('gzip') ? 'gzip' : undefined
}

type StaticWebCompressedVariant = { encoding: 'br' | 'gzip'; bytes: Buffer }

/** Serves each file version's compressed form once per encoding; misses resolve to identity. */
function compressedStaticVariant(
  absolutePath: string,
  fileStat: Stats,
  encoding: 'br' | 'gzip'
): Promise<StaticWebCompressedVariant | null> {
  const key = `${absolutePath}:${fileStat.size}:${fileStat.mtimeMs}:${encoding}`
  const cached = staticWebCompressedCache.get(key)
  if (cached) {
    // Map order is insertion order; re-inserting marks the entry most recently used.
    staticWebCompressedCache.delete(key)
    staticWebCompressedCache.set(key, cached)
    return cached.promise
  }
  const entry: StaticWebCompressedEntry = {
    promise: compressStaticAsset(absolutePath, encoding)
      .then((bytes): StaticWebCompressedVariant | null => (bytes ? { encoding, bytes } : null))
      // A read or zlib failure resolves to identity so one bad file still serves.
      .catch(() => null),
    accountedBytes: fileStat.size,
    evicted: false
  }
  void entry.promise.then((variant) => {
    if (!entry.evicted) {
      staticWebCompressedBytes += (variant?.bytes.byteLength ?? 0) - entry.accountedBytes
      entry.accountedBytes = variant?.bytes.byteLength ?? 0
      evictStaticWebCompressed()
    }
  })
  staticWebCompressedBytes += entry.accountedBytes
  staticWebCompressedCache.set(key, entry)
  evictStaticWebCompressed()
  return entry.promise
}

async function compressStaticAsset(
  absolutePath: string,
  encoding: 'br' | 'gzip'
): Promise<Buffer | null> {
  const source = await readFile(absolutePath)
  const compressed = encoding === 'br' ? await brotliCompressAsync(source) : await gzipAsync(source)
  // Why: already-dense bodies can grow under an encoding; the stream then costs less than the variant.
  return compressed.byteLength < source.byteLength ? compressed : null
}

function evictStaticWebCompressed(): void {
  while (
    staticWebCompressedCache.size > STATIC_WEB_COMPRESSED_MAX_ENTRIES ||
    staticWebCompressedBytes > STATIC_WEB_COMPRESSED_MAX_BYTES
  ) {
    const oldest = staticWebCompressedCache.keys().next()
    if (oldest.done) {
      break
    }
    const entry = staticWebCompressedCache.get(oldest.value)
    staticWebCompressedCache.delete(oldest.value)
    if (entry) {
      entry.evicted = true
      staticWebCompressedBytes -= entry.accountedBytes
    }
  }
}

function writeHttpStatus(response: ServerResponse, statusCode: number): void {
  if (response.destroyed) {
    return
  }
  response.statusCode = statusCode
  response.end()
}
