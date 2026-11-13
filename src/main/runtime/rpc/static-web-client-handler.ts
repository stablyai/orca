import { closeSync, createReadStream, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { readBundledWebClientFiles } from '../../../shared/bundled-web-client-manifest'

const STATIC_WEB_ALLOWED_PATHS = new Set([
  '/web-index.html',
  '/orca-web-icon',
  '/manifest.webmanifest'
])
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
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2']
])
const WEB_ICON_ROUTE = '/orca-web-icon'
const WEB_MANIFEST_ROUTE = '/manifest.webmanifest'
const WEB_ICON_ENV_VAR = 'ORCA_WEB_ICON'
const WEB_ICON_EXTENSIONS = new Set(['.png', '.svg', '.ico', '.webp'])

type StaticWebIconEntry = {
  src: string
  // Declared slots the image can serve: its real dimensions plus the
  // installability sizes no larger than them (browsers scale down).
  sizes: string
  type: string
}

type StaticWebIcon = {
  absolutePath: string
  contentType: string
  manifestIcons: StaticWebIconEntry[]
}

const INSTALLABILITY_ICON_EDGES = [192, 512]

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
  const icon = resolveStaticWebIcon(resolvedRoot, files, process.env[WEB_ICON_ENV_VAR])
  return (request, response) => {
    void handleStaticRequest(resolvedRoot, files, icon, request, response)
  }
}

async function handleStaticRequest(
  staticRoot: string,
  files: ReadonlySet<string> | undefined,
  icon: StaticWebIcon | undefined,
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
  if (pathname === WEB_ICON_ROUTE || pathname === WEB_MANIFEST_ROUTE) {
    if (!icon) {
      writeHttpStatus(response, 404)
      return
    }
    if (pathname === WEB_ICON_ROUTE) {
      await streamStaticFile(response, request, icon.absolutePath, icon.contentType, 'no-cache')
      return
    }
    writeJsonBody(response, request, buildWebManifest(icon))
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

  if (pathname === '/web-index.html' && icon) {
    await sendWebIndex(response, request, absolutePath, icon)
    return
  }

  await streamStaticFile(
    response,
    request,
    absolutePath,
    STATIC_WEB_CONTENT_TYPES.get(extname(absolutePath)) ?? 'application/octet-stream',
    pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  )
}

/** Buffers only the index page; linking the icon and manifest costs one small read per load. */
async function sendWebIndex(
  response: ServerResponse,
  request: IncomingMessage,
  absolutePath: string,
  icon: StaticWebIcon
): Promise<void> {
  let html: string
  try {
    html = await readFile(absolutePath, 'utf8')
  } catch {
    writeHttpStatus(response, 404)
    return
  }
  if (response.destroyed) {
    return
  }
  const links =
    `<link rel="icon" type="${icon.contentType}" href=".${WEB_ICON_ROUTE}">` +
    `<link rel="manifest" href=".${WEB_MANIFEST_ROUTE}">`
  const headEnd = html.indexOf('</head>')
  const body = headEnd === -1 ? html : html.slice(0, headEnd) + links + html.slice(headEnd)
  response.statusCode = 200
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.setHeader('Cache-Control', 'no-cache')
  response.end(request.method === 'HEAD' ? undefined : body)
}

function writeJsonBody(
  response: ServerResponse,
  request: IncomingMessage,
  value: unknown
): void {
  const body = JSON.stringify(value)
  response.statusCode = 200
  response.setHeader('Content-Type', 'application/manifest+json; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.setHeader('Cache-Control', 'no-cache')
  response.end(request.method === 'HEAD' ? undefined : body)
}

function buildWebManifest(icon: StaticWebIcon): unknown {
  return {
    name: 'Orca',
    short_name: 'Orca',
    // Relative URLs resolve against the manifest URL so prefix proxies keep working.
    start_url: 'web-index.html',
    display: 'standalone',
    icons: icon.manifestIcons.map((entry) => ({ ...entry, purpose: 'any' }))
  }
}

async function streamStaticFile(
  response: ServerResponse,
  request: IncomingMessage,
  absolutePath: string,
  contentType: string,
  cacheControl: string
): Promise<void> {
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
  response.setHeader('Content-Type', contentType)
  response.setHeader('Content-Length', fileStat.size)
  response.setHeader('Cache-Control', cacheControl)
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
  if (pathname.endsWith(WEB_ICON_ROUTE)) {
    return WEB_ICON_ROUTE
  }
  if (pathname.endsWith(WEB_MANIFEST_ROUTE)) {
    return WEB_MANIFEST_ROUTE
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

/** ORCA_WEB_ICON wins for custom branding; otherwise the bundled assets/icon-*.png becomes the default. */
function resolveStaticWebIcon(
  staticRoot: string,
  files: ReadonlySet<string> | undefined,
  envPath: string | undefined
): StaticWebIcon | undefined {
  const override = envPath?.trim()
  if (override) {
    const overrideExt = extname(override).toLowerCase()
    const contentType = STATIC_WEB_CONTENT_TYPES.get(overrideExt)
    if (!isAbsolute(override) || !contentType || !WEB_ICON_EXTENSIONS.has(overrideExt)) {
      console.warn(
        `[ws-transport] ${WEB_ICON_ENV_VAR} ignored: ${override} is not an absolute path to ${[...WEB_ICON_EXTENSIONS].join('/')}`
      )
    } else {
      try {
        if (statSync(override).isFile()) {
          // Custom branding replaces the manifest icon list entirely.
          return {
            absolutePath: override,
            contentType,
            manifestIcons: [
              {
                src: WEB_ICON_ROUTE.slice(1),
                sizes: manifestIconSizes(override),
                type: contentType
              }
            ]
          }
        }
      } catch {
        // fall through to the bundled icon
      }
      console.warn(`[ws-transport] ${WEB_ICON_ENV_VAR} ignored: cannot read ${override}`)
    }
  }
  const bundled = findBundledWebIcons(staticRoot, files)
  if (bundled.length === 0) {
    return undefined
  }
  const primary = bundled.find((file) => /^assets\/icon-[^/]*\.png$/.test(file)) ?? bundled[0]
  return {
    absolutePath: join(staticRoot, primary),
    contentType: 'image/png',
    // Larger alternates ship beside the default icon; listing each at its own
    // path gives the manifest the 192/512 entries installability needs.
    manifestIcons: bundled.map((file) => ({
      src: file,
      sizes: manifestIconSizes(join(staticRoot, file)),
      type: 'image/png'
    }))
  }
}

/** Every branded icon the web bundle emits: icon-*.png plus the alternate app icons. */
function findBundledWebIcons(
  staticRoot: string,
  files: ReadonlySet<string> | undefined
): string[] {
  const matches = (file: string) => /^assets\/(?:icon|orca)-[^/]*\.png$/.test(file)
  if (files) {
    return [...files].filter(matches).sort()
  }
  try {
    return readdirSync(join(staticRoot, 'assets'))
      .filter((entry) => matches(`assets/${entry}`))
      .sort()
      .map((entry) => `assets/${entry}`)
  } catch {
    return []
  }
}

function manifestIconSizes(absolutePath: string): string {
  const dimensions = readPngDimensions(absolutePath)
  if (!dimensions) {
    return 'any'
  }
  const sizes = new Set([`${dimensions.width}x${dimensions.height}`])
  for (const edge of INSTALLABILITY_ICON_EDGES) {
    if (edge <= Math.min(dimensions.width, dimensions.height)) {
      sizes.add(`${edge}x${edge}`)
    }
  }
  return [...sizes].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join(' ')
}

function readPngDimensions(absolutePath: string): { width: number; height: number } | undefined {
  let fd: number | undefined
  try {
    const header = Buffer.alloc(24)
    fd = openSync(absolutePath, 'r')
    readSync(fd, header, 0, 24, 0)
    if (header.readUInt32BE(0) !== 0x89504e47) {
      return undefined
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}
