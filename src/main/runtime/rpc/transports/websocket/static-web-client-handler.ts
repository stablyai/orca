import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, posix, relative, resolve } from 'node:path'
import { readBundledWebClientFiles } from '../../../../../shared/web-client/bundled-web-client-manifest'
import {
  InstalledMobileWebBundleManifestSchema,
  MOBILE_WEB_BUNDLE_ENTRYPOINT
} from '../../../../../shared/mobile-web-bundle/manifest-contract'
import {
  MOBILE_WEB_BROWSER_MANIFEST_PATH,
  MOBILE_WEB_BROWSER_PATH
} from '../../../../../shared/mobile-web-bundle/mobile-web-browser-path'

const STATIC_WEB_ALLOWED_PATHS = new Set(['/web-index.html'])
const STATIC_WEB_ALLOWED_PREFIXES = ['/assets/', '/cmaps/', '/standard_fonts/', '/wasm/']
// The page writes its route into the address bar, so a reload asks for it by that route.
const MOBILE_WEB_ROUTE_PREFIX = '/h/'
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

type StaticTree = { root: string; files: ReadonlySet<string> | undefined }
type MobileWebTree = { root: string; files: ReadonlySet<string> }
type StaticFile = { root: string; file: string }

export function createStaticWebClientHandler(
  staticRoot: string | undefined,
  findMobileWebRoot?: () => Promise<string | undefined>
): RequestListener {
  let web: StaticTree | undefined
  if (staticRoot !== undefined) {
    const root = resolve(staticRoot)
    try {
      const files = readBundledWebClientFiles(root)
      web = basename(root) === 'renderer' && !files ? undefined : { root, files }
    } catch (error) {
      // Damaged web installs must not disable the runtime server.
      console.warn(`[ws-transport] browser client disabled: ${String(error)}`)
    }
  }
  const mobile = findMobileWebRoot ? readMobileWebTree(findMobileWebRoot) : undefined
  if (!web && !mobile) {
    return answerWithoutWebClient
  }
  return (request, response) => {
    void handleStaticRequest(web, mobile, request, response)
  }
}

// Found on first request and kept once found; a dev build may produce the bundle after startup.
function readMobileWebTree(
  findRoot: () => Promise<string | undefined>
): () => Promise<MobileWebTree | null> {
  let found: Promise<MobileWebTree | null> | undefined
  const load = async (): Promise<MobileWebTree | null> => {
    const root = await findRoot()
    if (root === undefined) {
      return null
    }
    try {
      const raw = await readFile(resolve(root, 'manifest.json'), 'utf8')
      const manifest = InstalledMobileWebBundleManifestSchema.parse(JSON.parse(raw))
      return { root: resolve(root), files: new Set(manifest.assets.map((asset) => asset.path)) }
    } catch (error) {
      console.warn(`[ws-transport] mobile web page disabled: ${String(error)}`)
      return null
    }
  }
  return async () => {
    found ??= load()
    const tree = await found
    if (tree === null) {
      found = undefined
    }
    return tree
  }
}

async function handleStaticRequest(
  web: StaticTree | undefined,
  mobile: (() => Promise<MobileWebTree | null>) | undefined,
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
  const served = await resolveStaticFile(pathname, web, mobile)
  if (!served) {
    writeHttpStatus(response, 404)
    return
  }

  const absolutePath = resolve(served.root, served.file)
  const relativePath = relative(served.root, absolutePath)
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

// Content-hashed names cannot collide, so an asset the desktop client lacks is looked up in the page's manifest.
async function resolveStaticFile(
  pathname: string,
  web: StaticTree | undefined,
  readMobile: (() => Promise<MobileWebTree | null>) | undefined
): Promise<StaticFile | null> {
  const webServes = web !== undefined && isAllowedStaticWebPath(pathname)
  if (webServes && web.files?.has(pathname.slice(1))) {
    return { root: web.root, file: pathname.slice(1) }
  }
  const mobile = readMobile ? await readMobile() : null
  // A desktop tree without a file list claims every allowed path, so only after the page's list.
  const unlistedWeb = webServes && !web.files ? { root: web.root, file: pathname.slice(1) } : null
  if (!mobile) {
    return unlistedWeb
  }
  if (
    pathname === MOBILE_WEB_BROWSER_PATH ||
    pathname === `${MOBILE_WEB_BROWSER_PATH}/` ||
    pathname.startsWith(MOBILE_WEB_ROUTE_PREFIX)
  ) {
    return { root: mobile.root, file: MOBILE_WEB_BUNDLE_ENTRYPOINT }
  }
  if (pathname === MOBILE_WEB_BROWSER_MANIFEST_PATH) {
    return { root: mobile.root, file: 'manifest.json' }
  }
  return pathname.startsWith('/assets/') && mobile.files.has(pathname.slice(1))
    ? { root: mobile.root, file: pathname.slice(1) }
    : unlistedWeb
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
