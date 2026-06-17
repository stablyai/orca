import {
  deleteTrelloCredentials,
  getTrelloCredentialsMetadata,
  loadTrelloToken,
  saveTrelloCredentials,
  updateTrelloViewer
} from './credentials'

import type {
  TrelloConnectArgs,
  TrelloConnectionStatus,
  TrelloViewer
} from '../../shared/trello-types'

const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return
  }
  const { promise, resolve } = Promise.withResolvers<void>()
  queue.push(() => {
    running++
    resolve()
  })
  return promise
}

export function release(): void {
  running--
  if (queue.length > 0) {
    queue.shift()?.()
  }
}

export class TrelloApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'TrelloApiError'
  }
}
type TrelloAttachmentMetadata = {
  id?: string
  url?: string
  mimeType?: string
  name?: string
  fileName?: string
}

function toViewer(data: Record<string, unknown>): TrelloViewer {
  return {
    id: typeof data.id === 'string' ? data.id : '',
    username: typeof data.username === 'string' ? data.username : '',
    displayName:
      typeof data.fullName === 'string'
        ? data.fullName
        : typeof data.username === 'string'
          ? data.username
          : '',
    avatarUrl: typeof data.avatarUrl === 'string' ? data.avatarUrl : undefined
  }
}

async function requestWithCredentials(
  apiKey: string,
  token: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const url = new URL(`https://api.trello.com/1${path}`)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('token', token)

  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')

  const response = await fetch(url.toString(), {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new TrelloApiError(await readTrelloError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

async function readTrelloError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      message?: string
      error?: string
    }
    const messages = [data.message, data.error].filter(Boolean)
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Trello request failed (${response.status})`
}

export async function trelloRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const file = getTrelloCredentialsMetadata()
  const apiKey = file.apiKey
  const token = loadTrelloToken()
  if (!apiKey || !token) {
    throw new TrelloApiError('Not connected to Trello.', 401)
  }

  const url = new URL(`https://api.trello.com/1${path}`)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('token', token)

  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  if (
    init?.method &&
    init.method !== 'GET' &&
    init.method !== 'HEAD' &&
    typeof init.body === 'string'
  ) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(url.toString(), {
    ...init,
    headers
  })
  if (!response.ok) {
    const error = new TrelloApiError(await readTrelloError(response), response.status)
    // Only clear credentials on 401 (token-invalid / unauthenticated).  403
    // indicates a scope or resource permission issue that should not revoke
    // stored credentials.
    if (error.status === 401) {
      deleteTrelloCredentials()
    }
    throw error
  }
  if (response.status === 204) {
    return null as T
  }
  return (await response.json()) as T
}
function isTrelloDownloadHost(hostname: string): boolean {
  return hostname === 'trello.com' || hostname === 'api.trello.com'
}

function trelloAuthorizationHeader(apiKey: string, token: string): string {
  return `OAuth oauth_consumer_key="${apiKey}", oauth_token="${token}"`
}

function parseTrelloAttachmentDownloadUrl(
  url: URL
): { cardId: string; attachmentId: string } | null {
  const parts = url.pathname.split('/').filter(Boolean)
  const cardsIndex = parts.indexOf('cards')
  if (
    cardsIndex === -1 ||
    parts[cardsIndex + 2] !== 'attachments' ||
    parts[cardsIndex + 4] !== 'download'
  ) {
    return null
  }
  const cardId = parts[cardsIndex + 1]
  const attachmentId = parts[cardsIndex + 3]
  return cardId && attachmentId ? { cardId, attachmentId } : null
}

async function getTrelloAttachmentDownloadUrl(url: URL): Promise<string> {
  const ids = parseTrelloAttachmentDownloadUrl(url)
  if (!ids) {
    return url.toString()
  }
  try {
    const attachment = await trelloRequest<TrelloAttachmentMetadata>(
      `/cards/${encodeURIComponent(ids.cardId)}/attachments/${encodeURIComponent(
        ids.attachmentId
      )}?fields=url,mimeType,name,fileName`
    )
    if (typeof attachment.url === 'string' && attachment.url) {
      return attachment.url
    }
  } catch (error) {
    console.warn(
      '[trello] Failed to resolve attachment metadata before image download:',
      error instanceof Error ? error.message : String(error)
    )
  }
  return url.toString()
}

async function downloadTrelloAttachment(
  urlString: string,
  apiKey: string,
  token: string
): Promise<Response> {
  const url = new URL(urlString)
  if (url.protocol !== 'https:') {
    throw new TrelloApiError('Attachment URL must use HTTPS.', 400)
  }
  // Only allow fetching from Trello-hosted domains.  Rejecting attachment URLs
  // that point to arbitrary hosts prevents SSRF via Trello attachment metadata.
  if (!isTrelloDownloadHost(url.hostname)) {
    throw new TrelloApiError('Attachment URL is not hosted on Trello.', 400)
  }
  const headers: Record<string, string> = {
    Accept: 'image/*,application/octet-stream'
  }
  headers.Authorization = trelloAuthorizationHeader(apiKey, token)
  return fetch(url.toString(), {
    redirect: 'follow',
    headers
  })
}

export async function trelloDownload(urlString: string): Promise<{
  contentType: string
  contentBase64: string
}> {
  const file = getTrelloCredentialsMetadata()
  const apiKey = file.apiKey
  const token = loadTrelloToken()
  if (!apiKey || !token) {
    throw new TrelloApiError('Not connected to Trello.', 401)
  }

  const url = new URL(urlString)
  if (url.protocol !== 'https:' || !isTrelloDownloadHost(url.hostname)) {
    throw new TrelloApiError('Unsupported Trello image URL.', 400)
  }
  if (!url.pathname.startsWith('/1/cards/') || !url.pathname.includes('/download/')) {
    throw new TrelloApiError('Unsupported Trello image URL.', 400)
  }

  await acquire()
  try {
    const downloadUrl = await getTrelloAttachmentDownloadUrl(url)
    const response = await downloadTrelloAttachment(downloadUrl, apiKey, token)
    if (!response.ok) {
      const error = new TrelloApiError(await readTrelloError(response), response.status)
      if (error.status === 401) {
        deleteTrelloCredentials()
      }
      throw error
    }
    return {
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      contentBase64: Buffer.from(await response.arrayBuffer()).toString('base64')
    }
  } finally {
    release()
  }
}

export function getStatus(): TrelloConnectionStatus {
  const file = getTrelloCredentialsMetadata()
  const tokenReadable = file.hasToken && loadTrelloToken() !== null
  return {
    connected: tokenReadable && !!file.apiKey && !!file.viewer,
    viewer: file.viewer
  }
}

export async function connect(
  args: TrelloConnectArgs
): Promise<{ ok: true; viewer: TrelloViewer } | { ok: false; error: string }> {
  const apiKey = args.apiKey.trim()
  const token = args.token.trim()
  if (!apiKey || !token) {
    return { ok: false, error: 'API key and token are required.' }
  }

  await acquire()
  try {
    const data = (await requestWithCredentials(apiKey, token, '/members/me')) as Record<
      string,
      unknown
    >
    const viewer = toViewer(data)
    saveTrelloCredentials(apiKey, token, viewer)
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function disconnect(): void {
  deleteTrelloCredentials()
}

export async function testConnection(): Promise<
  { ok: true; viewer: TrelloViewer } | { ok: false; error: string }
> {
  const file = getTrelloCredentialsMetadata()
  if (!file.apiKey || !loadTrelloToken()) {
    return { ok: false, error: 'Not connected to Trello.' }
  }

  await acquire()
  try {
    const data = await trelloRequest<Record<string, unknown>>('/members/me')
    const viewer = toViewer(data)
    // Refresh stored viewer
    updateTrelloViewer(viewer)
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Test failed.' }
  } finally {
    release()
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof TrelloApiError && (error.status === 401 || error.status === 403)
}
