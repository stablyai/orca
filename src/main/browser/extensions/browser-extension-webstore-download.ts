import { net } from 'electron'
import { createHash } from 'node:crypto'
import { verifyCrx3, type VerifiedCrx } from './browser-extension-crx'

const MAX_CRX_BYTES = 256 * 1024 * 1024
const MAX_ICON_BYTES = 1024 * 1024
const CRX_HOST_SUFFIXES = ['google.com', 'googleusercontent.com', 'googleapis.com', 'gvt1.com']
const ICON_HOST_SUFFIXES = ['googleusercontent.com', 'ggpht.com', 'gstatic.com']
const ICON_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

function isHttpsUrlOnHosts(rawUrl: string, suffixes: string[]): boolean {
  try {
    const url = new URL(rawUrl)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      suffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))
    )
  } catch {
    return false
  }
}

export function isAllowedCrxDownloadUrl(rawUrl: string): boolean {
  return isHttpsUrlOnHosts(rawUrl, CRX_HOST_SUFFIXES)
}

export function isAllowedWebStoreIconUrl(rawUrl: string): boolean {
  return isHttpsUrlOnHosts(rawUrl, ICON_HOST_SUFFIXES)
}

/** Download URL shape from electron-chrome-web-store (MIT, Samuel Maddock). */
export function chromeWebStoreCrxUrl(
  extensionId: string,
  chromeVersion: string = process.versions.chrome
): string {
  const url = new URL('https://clients2.google.com/service/update2/crx')
  url.searchParams.set('response', 'redirect')
  url.searchParams.set('acceptformat', 'crx3')
  url.searchParams.set('prodversion', chromeVersion)
  url.searchParams.set(
    'x',
    new URLSearchParams({ id: extensionId, installsource: 'ondemand', uc: '' }).toString()
  )
  return url.toString()
}

async function readCappedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) {
    throw new Error('Download is too large')
  }
  if (!response.body) {
    return Buffer.alloc(0)
  }
  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('Download is too large')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/** Fetches a store CRX over https from Google hosts and verifies it before anything touches disk. */
export async function downloadWebStoreCrx(
  extensionId: string,
  options: { url?: string; sha256?: string; size?: number; fetcher?: Fetcher } = {}
): Promise<VerifiedCrx> {
  const url = options.url ?? chromeWebStoreCrxUrl(extensionId)
  if (!isAllowedCrxDownloadUrl(url)) {
    throw new Error('Extension download address is not a Chrome Web Store address')
  }
  const fetcher: Fetcher = options.fetcher ?? ((target, init) => net.fetch(target, init))
  const controller = new AbortController()
  try {
    const response = await fetcher(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`Chrome Web Store download failed (${response.status})`)
    }
    if (response.url && !isAllowedCrxDownloadUrl(response.url)) {
      throw new Error('Extension download was redirected away from Google')
    }
    const bytes = await readCappedBody(response, MAX_CRX_BYTES)
    if (options.size !== undefined && bytes.length !== options.size) {
      throw new Error('Extension download is incomplete')
    }
    if (
      options.sha256 !== undefined &&
      createHash('sha256').update(bytes).digest('hex') !== options.sha256.toLowerCase()
    ) {
      throw new Error('Extension download does not match its checksum')
    }
    return verifyCrx3(bytes, { expectedExtensionId: extensionId, requirePublisherProof: true })
  } finally {
    controller.abort()
  }
}

/** The store's listing icon as a data URL for Orca's prompt (the renderer CSP blocks remote images). */
export async function fetchWebStoreIconDataUrl(
  iconUrl: string,
  fetcher: Fetcher = (target, init) => net.fetch(target, init)
): Promise<string> {
  if (!isAllowedWebStoreIconUrl(iconUrl)) {
    throw new Error('Invalid icon url')
  }
  const controller = new AbortController()
  try {
    const response = await fetcher(iconUrl, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    })
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (
      !response.ok ||
      !ICON_MIME_TYPES.has(mime) ||
      (response.url && !isAllowedWebStoreIconUrl(response.url))
    ) {
      throw new Error('Icon could not be loaded')
    }
    const bytes = await readCappedBody(response, MAX_ICON_BYTES)
    return `data:${mime};base64,${bytes.toString('base64')}`
  } finally {
    controller.abort()
  }
}
