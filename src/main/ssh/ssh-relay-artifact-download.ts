import { createHash } from 'node:crypto'
import { open, rm, type FileHandle } from 'node:fs/promises'

import { net } from 'electron'

import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const RELEASE_ASSET_HOST = 'release-assets.githubusercontent.com'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const REQUEST_INIT = {
  credentials: 'omit',
  headers: { Accept: 'application/octet-stream' },
  redirect: 'manual'
} as const

export type SshRelayArtifactDownloadResult = {
  destinationPath: string
  finalUrl: string
  size: number
  sha256: SshRelaySelectedArtifact['archive']['sha256']
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

function approvedRedirect(response: Response, sourceUrl: string): string {
  const location = response.headers.get('location')
  if (!location) {
    throw new Error('SSH relay artifact redirect is missing Location')
  }
  const url = new URL(location, sourceUrl)
  if (url.protocol !== 'https:') {
    throw new Error('SSH relay artifact redirect must use HTTPS')
  }
  if (url.hostname !== RELEASE_ASSET_HOST) {
    throw new Error('SSH relay artifact redirect has an unapproved origin')
  }
  if (url.username || url.password) {
    throw new Error('SSH relay artifact redirect must not contain credentials')
  }
  if (url.port) {
    throw new Error('SSH relay artifact redirect must not use a custom port')
  }
  return url.href
}

async function fetchArtifactResponse(
  artifact: SshRelaySelectedArtifact,
  signal: AbortSignal
): Promise<{ response: Response; finalUrl: string }> {
  const initialUrl = artifact.archive.downloadUrl
  const initial = await net.fetch(initialUrl, { ...REQUEST_INIT, signal })
  if (initial.status === 200) {
    return { response: initial, finalUrl: initialUrl }
  }
  if (!REDIRECT_STATUSES.has(initial.status)) {
    await discardResponse(initial)
    throw new Error(`SSH relay artifact download failed with status ${initial.status}`)
  }

  let finalUrl: string
  try {
    finalUrl = approvedRedirect(initial, initialUrl)
  } finally {
    await discardResponse(initial)
  }
  // Why: every request uses a fresh fixed header set and omits session credentials so a signed CDN
  // redirect cannot inherit authorization, cookies, or caller-controlled headers.
  const redirected = await net.fetch(finalUrl, { ...REQUEST_INIT, signal })
  if (REDIRECT_STATUSES.has(redirected.status)) {
    await discardResponse(redirected)
    throw new Error('SSH relay artifact download exceeded the approved redirect limit')
  }
  if (redirected.status !== 200) {
    await discardResponse(redirected)
    throw new Error(`SSH relay artifact download failed with status ${redirected.status}`)
  }
  return { response: redirected, finalUrl }
}

async function writeCompleteChunk(file: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, null)
    if (bytesWritten <= 0) {
      throw new Error('SSH relay artifact download could not persist response bytes')
    }
    offset += bytesWritten
  }
}

async function streamVerifiedResponse(
  response: Response,
  artifact: SshRelaySelectedArtifact,
  signal: AbortSignal,
  file: FileHandle
): Promise<{ size: number; sha256: SshRelaySelectedArtifact['archive']['sha256'] }> {
  const expected = artifact.archive
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (!Number.isSafeInteger(parsed) || parsed !== expected.size) {
      await discardResponse(response)
      throw new Error('SSH relay artifact Content-Length disagrees with the signed manifest')
    }
  }
  if (!response.body) {
    throw new Error('SSH relay artifact response body is missing')
  }

  const hash = createHash('sha256')
  const reader = response.body.getReader()
  let size = 0
  let complete = false
  const cancelRead = (): void => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', cancelRead, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) {
        complete = true
        break
      }
      const buffer = Buffer.from(value)
      size += buffer.length
      if (size > expected.size) {
        throw new Error('SSH relay artifact response exceeds the signed size')
      }
      hash.update(buffer)
      await writeCompleteChunk(file, buffer)
    }
  } finally {
    signal.removeEventListener('abort', cancelRead)
    if (!complete) {
      await reader.cancel(signal.aborted ? signal.reason : undefined).catch(() => {})
    }
    reader.releaseLock()
  }

  if (size !== expected.size) {
    throw new Error('SSH relay artifact response size does not match the signed manifest')
  }
  const sha256 = `sha256:${hash.digest('hex')}` as SshRelaySelectedArtifact['archive']['sha256']
  if (sha256 !== expected.sha256) {
    throw new Error('SSH relay artifact response SHA-256 does not match the signed manifest')
  }
  return { size, sha256 }
}

export async function downloadSshRelayArtifact({
  artifact,
  destinationPath,
  signal
}: {
  artifact: SshRelaySelectedArtifact
  destinationPath: string
  signal?: AbortSignal
}): Promise<SshRelayArtifactDownloadResult> {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
    : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()

  // Why: this boundary owns only a new staging file; cache publication and replacement are later,
  // separately gated transactions.
  const file = await open(destinationPath, 'wx', 0o600)
  let complete = false
  try {
    const { response, finalUrl } = await fetchArtifactResponse(artifact, effectiveSignal)
    const verified = await streamVerifiedResponse(response, artifact, effectiveSignal, file)
    await file.sync()
    effectiveSignal.throwIfAborted()
    complete = true
    return { destinationPath, finalUrl, ...verified }
  } finally {
    await file.close().catch(() => {})
    if (!complete) {
      await rm(destinationPath, { force: true }).catch(() => {})
    }
  }
}
