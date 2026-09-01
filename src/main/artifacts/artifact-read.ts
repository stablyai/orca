import {
  ARTIFACT_CLI_MAX_READ_BYTES,
  ARTIFACT_CLI_MAX_RPC_BYTES,
  type ArtifactReadResult
} from '../../shared/artifacts'
import { OrcaCloudRequestError } from '../orca-profiles/profile-cloud-client'
import { artifactFetch, type ArtifactFetchOptions } from './artifact-cloud-request'

const SHARE_HOST = 'share.onorca.dev'
const CONTENT_HOST = 'content.orcausercontent.dev'
const TIMEOUT_MS = 20_000

export class ArtifactReadMetadataError extends OrcaCloudRequestError {
  constructor(statusCode: number, errorCode?: string) {
    super(statusCode, errorCode)
    this.name = 'ArtifactReadMetadataError'
  }
}

type ArtifactReadTarget = {
  id: string
  shareUrl: string
}

type ArtifactReadFetchOptions = {
  apiUrl: string
  token?: string
  maxBytes?: number
  fetchImpl?: (url: string, options?: ArtifactFetchOptions) => Promise<Response>
}

type ArtifactTextResponse = {
  contentType: string
  text: string
}

function isLoopback(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
}

function validArtifactId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function parseTarget(input: string, apiUrl: string): ArtifactReadTarget {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Artifact id or share URL is required.')
  }
  if (!trimmed.includes('://')) {
    if (!validArtifactId(trimmed)) {
      throw new Error('Artifact id is invalid.')
    }
    const apiOrigin = new URL(apiUrl)
    const shareOrigin = isLoopback(apiOrigin.hostname) ? apiOrigin.origin : `https://${SHARE_HOST}`
    return { id: trimmed, shareUrl: `${shareOrigin}/a/${encodeURIComponent(trimmed)}` }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Artifact share URL is invalid.')
  }
  const apiOrigin = new URL(apiUrl)
  const allowedOrigin = isLoopback(apiOrigin.hostname)
    ? url.origin === apiOrigin.origin
    : url.origin === `https://${SHARE_HOST}`
  if (!allowedOrigin) {
    throw new Error('Artifact share URL must use the Orca share host.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Artifact share URL must not contain credentials, query parameters, or fragments.'
    )
  }
  const match = /^\/a\/([^/]+)\/?$/.exec(url.pathname)
  if (!match || !validArtifactId(match[1])) {
    throw new Error('Artifact share URL path is invalid.')
  }
  return { id: match[1], shareUrl: `${url.origin}/a/${encodeURIComponent(match[1])}` }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      throw new Error('Artifact content exceeds the CLI size limit.')
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('Artifact content is not valid UTF-8.')
    }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new Error('Artifact content exceeds the CLI size limit.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    )
  } catch {
    throw new Error('Artifact content is not valid UTF-8.')
  }
}

async function fetchText(
  url: string,
  options: ArtifactReadFetchOptions,
  expectedTypes: readonly string[],
  includeToken = false
): Promise<ArtifactTextResponse> {
  const response = await (options.fetchImpl ?? artifactFetch)(url, {
    token: includeToken ? options.token : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) {
    let code: string | undefined
    try {
      code = (JSON.parse(await readResponseText(response, 16 * 1024)) as { code?: unknown })
        .code as string | undefined
    } catch {
      /* non-JSON error */
    }
    throw new OrcaCloudRequestError(response.status, code)
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (!contentType || !expectedTypes.includes(contentType)) {
    throw new Error(`Unsupported artifact response content type: ${contentType ?? 'missing'}.`)
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(contentLength) &&
    contentLength > (options.maxBytes ?? ARTIFACT_CLI_MAX_READ_BYTES)
  ) {
    await response.body?.cancel()
    throw new Error('Artifact content exceeds the CLI size limit.')
  }
  return {
    contentType,
    text: await readResponseText(response, options.maxBytes ?? ARTIFACT_CLI_MAX_READ_BYTES)
  }
}

function parseIframe(wrapper: string, id: string, apiUrl: string): string {
  const matches = [...wrapper.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
  if (matches.length !== 1) {
    throw new Error('Artifact share page did not contain exactly one content frame.')
  }
  let url: URL
  try {
    url = new URL(matches[0][1], apiUrl)
  } catch {
    throw new Error('Artifact content URL is invalid.')
  }
  const apiOrigin = new URL(apiUrl)
  const allowed =
    url.origin === `https://${CONTENT_HOST}` ||
    (isLoopback(apiOrigin.hostname) && url.origin === apiUrl)
  if (
    url.protocol !== apiOrigin.protocol ||
    !allowed ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Artifact content URL is not an allowed Orca content URL.')
  }
  const expectedPath = `/usercontent/${encodeURIComponent(id)}/artifact.html`
  if (url.pathname !== expectedPath) {
    throw new Error('Artifact content URL does not match the requested artifact.')
  }
  return url.toString()
}

export async function readArtifactContent(
  input: string,
  options: ArtifactReadFetchOptions
): Promise<ArtifactReadResult> {
  const target = parseTarget(input, options.apiUrl)
  let metadataText: string
  try {
    metadataText = (
      await fetchText(
        `${options.apiUrl}/v1/artifacts/${encodeURIComponent(target.id)}`,
        options,
        ['application/json'],
        true
      )
    ).text
  } catch (error) {
    if (error instanceof OrcaCloudRequestError) {
      throw new ArtifactReadMetadataError(error.statusCode, error.errorCode)
    }
    throw error
  }
  let metadata: ArtifactReadResult['artifact']
  let shareUrl = target.shareUrl
  try {
    const value = JSON.parse(metadataText) as {
      artifact?: ArtifactReadResult['artifact']
      shareUrl?: unknown
    }
    if (!value.artifact || typeof value.shareUrl !== 'string') {
      throw new Error('Malformed artifact metadata.')
    }
    const metadataShareUrl = new URL(value.shareUrl)
    if (
      metadataShareUrl.username ||
      metadataShareUrl.password ||
      metadataShareUrl.search ||
      metadataShareUrl.hash ||
      metadataShareUrl.pathname !== new URL(target.shareUrl).pathname
    ) {
      throw new Error('Malformed artifact metadata.')
    }
    if (
      value.artifact.slug !== target.id ||
      !['text/html', 'text/markdown'].includes(value.artifact.sourceContentType) ||
      value.artifact.renderedContentType !== 'text/html'
    ) {
      throw new Error('Malformed artifact metadata.')
    }
    metadata = value.artifact
    shareUrl = target.shareUrl
  } catch {
    throw new Error('Artifact metadata response was malformed.')
  }
  const wrapper = await fetchText(target.shareUrl, options, ['text/html'], false)
  const contentUrl = parseIframe(wrapper.text, target.id, options.apiUrl)
  const contentResponse = await fetchText(contentUrl, options, [
    'text/html',
    'text/markdown',
    'text/plain'
  ])
  const result = {
    artifact: metadata,
    shareUrl,
    contentType: contentResponse.contentType,
    content: contentResponse.text
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > ARTIFACT_CLI_MAX_RPC_BYTES) {
    throw new Error('Artifact content exceeds the CLI transport size limit.')
  }
  return result
}

export { parseTarget }
