/* eslint-disable max-lines -- Why: model download, checksum, extraction, and cleanup share one state machine so progress/error transitions stay coupled. */
import { app, net } from 'electron'
import { join, resolve, relative } from 'node:path'
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  createReadStream,
  rmSync,
  statSync
} from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import type {
  SpeechModelManifest,
  SpeechModelState,
  SpeechModelStatus
} from '../../shared/speech-types'
import { SPEECH_MODEL_CATALOG, getCatalogModel, isLocalSpeechModel } from './model-catalog'
import { hasOpenAiSpeechApiKey } from './openai-api-key-store'
import { resolveTarExecutable } from './tar-executable'
import {
  getSpeechModelCacheDirCandidates,
  migrateSpeechModelCacheIfNeeded,
  type SpeechModelCacheDir
} from './model-cache-path'

type DownloadHandle = {
  abort: () => void
}

type ProgressCallback = (modelId: string, progress: number) => void
type DownloadIncomingMessage = Electron.IncomingMessage &
  NodeJS.ReadableStream & {
    headers: Record<string, string | string[] | undefined>
    destroy?: () => void
  }
type HttpStatusError = Error & {
  httpStatusCode?: number
  retryAfterMs?: number
  retryable?: boolean
}
type DownloadTotals = { totalBytes: number }
type ContentRange = { start: number; end: number; totalBytes?: number }

const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000
// Why: flaky networks/proxies often kill long CDN transfers near the end; Range-resume lets them finish.
const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
// Why: count only CONSECUTIVE no-progress attempts, so a download still advancing across drops is never abandoned.
const MAX_NO_PROGRESS_ATTEMPTS = DOWNLOAD_RETRY_DELAYS_MS.length + 1
// Why: absolute backstop against a tiny-segment server; 4096 covers the ~1GB model even at a proxy's ~256KB min range.
const MAX_TOTAL_DOWNLOAD_REQUESTS = 4_096
// Why: cap honored Retry-After; a longer server window is surfaced for manual retry, not a multi-minute stall.
const MAX_RETRY_AFTER_MS = 120_000
const RETRYABLE_NET_ERROR =
  /net::ERR_(CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_(RESET|CLOSED|ABORTED|REFUSED|TIMED_OUT)|EMPTY_RESPONSE|NETWORK_CHANGED|TIMED_OUT|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NAME_NOT_RESOLVED|SOCKET_NOT_CONNECTED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)\b/
const RETRYABLE_HTTP_STATUSES = new Set([408, 416, 425, 429, 500, 502, 503, 504])

function isRetryableDownloadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const downloadError = error as HttpStatusError
  if (downloadError.retryable === true) {
    return true
  }
  const statusCode = downloadError.httpStatusCode
  if (statusCode !== undefined) {
    return RETRYABLE_HTTP_STATUSES.has(statusCode)
  }
  return (
    RETRYABLE_NET_ERROR.test(error.message) || error.message.includes('without network activity')
  )
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parseContentRange(value: string | string[] | undefined): ContentRange | null {
  const match = getHeaderValue(value)
    ?.trim()
    .match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i)
  if (!match) {
    return null
  }
  const start = Number.parseInt(match[1], 10)
  const end = Number.parseInt(match[2], 10)
  const totalBytes = match[3] === '*' ? undefined : Number.parseInt(match[3], 10)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    (totalBytes !== undefined && (!Number.isSafeInteger(totalBytes) || totalBytes <= end))
  ) {
    return null
  }
  return { start, end, totalBytes }
}

function parseRetryAfterMs(value: string | string[] | undefined): number | undefined {
  const header = getHeaderValue(value)?.trim()
  if (!header) {
    return undefined
  }
  if (/^\d+$/.test(header)) {
    const seconds = Number.parseInt(header, 10)
    const delayMs = seconds * 1_000
    return Number.isSafeInteger(delayMs) ? delayMs : undefined
  }
  const retryAt = Date.parse(header)
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - Date.now())
}

function describeInterruptedDownload(
  cause: unknown,
  receivedBytes: number,
  totalBytes: number,
  attempts: number
): Error {
  const causeMessage = cause instanceof Error ? cause.message : String(cause)
  const received =
    totalBytes > 0
      ? `${Math.min(99, Math.floor((receivedBytes / totalBytes) * 100))}% (${receivedBytes} of ${totalBytes} bytes)`
      : `${receivedBytes} bytes`
  return new Error(
    `Model download interrupted at ${received} after ${attempts} attempts: ${causeMessage}`
  )
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class ModelManager {
  private modelsDir: string
  private migrationSourceDir: string | null
  private migrationReady: Promise<void>
  private activeDownloads = new Map<string, DownloadHandle>()
  private modelStates = new Map<string, SpeechModelState>()
  private progressCallbacks = new Set<ProgressCallback>()

  constructor(customModelsDir?: string) {
    const requestedModelsDir = customModelsDir || join(app.getPath('userData'), 'speech-models')
    const prepared = this.prepareModelsDir(requestedModelsDir)
    this.modelsDir = prepared.modelsDir
    this.migrationSourceDir = prepared.migrationSourceDir
    // Why: migration copies large model files, so run it async and gate state reads on it to keep the UI responsive.
    this.migrationReady = migrateSpeechModelCacheIfNeeded(
      prepared.migrationSourceDir,
      prepared.modelsDir
    )
  }

  setProgressCallback(cb: ProgressCallback): () => void {
    // Why: return an unsubscribe so concurrent settings windows don't replace each other's callback.
    this.progressCallbacks.add(cb)
    return () => {
      this.progressCallbacks.delete(cb)
    }
  }

  getModelsDir(): string {
    return this.modelsDir
  }

  private prepareModelsDir(requestedModelsDir: string): SpeechModelCacheDir {
    let lastError: unknown = null
    for (const candidate of getSpeechModelCacheDirCandidates(requestedModelsDir)) {
      try {
        mkdirSync(candidate.modelsDir, { recursive: true })
        return candidate
      } catch (error) {
        lastError = error
        if (candidate.migrationSourceDir) {
          console.warn('[speech] Failed to prepare ASCII speech model cache:', error)
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  async getModelStates(): Promise<SpeechModelState[]> {
    const states: SpeechModelState[] = []
    for (const manifest of SPEECH_MODEL_CATALOG) {
      const state = await this.getModelState(manifest.id)
      states.push(state)
    }
    return states
  }

  async getModelState(modelId: string): Promise<SpeechModelState> {
    await this.migrationReady
    const cached = this.modelStates.get(modelId)
    if (cached && (cached.status === 'downloading' || cached.status === 'extracting')) {
      return cached
    }

    const manifest = getCatalogModel(modelId)
    if (!manifest) {
      return { id: modelId, status: 'error', error: 'Unknown model' }
    }

    if (manifest.provider === 'openai') {
      return {
        id: modelId,
        status: hasOpenAiSpeechApiKey() ? 'ready' : 'not-downloaded'
      }
    }

    const modelDir = this.getModelDir(modelId)
    if (existsSync(modelDir) && this.validateModelFiles(manifest, modelDir)) {
      const state: SpeechModelState = { id: modelId, status: 'ready' }
      this.modelStates.set(modelId, state)
      return state
    }

    return { id: modelId, status: 'not-downloaded' }
  }

  getModelDir(modelId: string): string {
    return this.getSafeModelDir(modelId)
  }

  private getSafeModelDir(modelId: string, root: string = this.modelsDir): string {
    const manifest = getCatalogModel(modelId)
    if (!manifest) {
      throw new Error(`Unknown model: ${modelId}`)
    }
    const modelsRoot = resolve(root)
    const modelDir = resolve(modelsRoot, modelId)
    const rel = relative(modelsRoot, modelDir)
    if (rel.startsWith('..') || rel === '' || rel.includes('..') || resolve(rel) === rel) {
      throw new Error(`Invalid model id: ${modelId}`)
    }
    return modelDir
  }

  private validateModelFiles(manifest: SpeechModelManifest, modelDir: string): boolean {
    if (!manifest.files) {
      return false
    }
    return manifest.files.every((f) => existsSync(join(modelDir, f)))
  }

  async downloadModel(modelId: string): Promise<void> {
    // Why: no migration await — it never races a download, and awaiting would defer setup cancelDownload relies on.
    if (this.activeDownloads.has(modelId)) {
      return
    }

    const manifest = getCatalogModel(modelId)
    if (!manifest) {
      throw new Error(`Unknown model: ${modelId}`)
    }
    if (!isLocalSpeechModel(manifest)) {
      throw new Error(`Model does not support downloads: ${modelId}`)
    }
    if (!manifest.downloadUrl || !manifest.archiveSha256 || !manifest.sizeBytes) {
      throw new Error(`Model download metadata missing: ${modelId}`)
    }

    const modelDir = this.getModelDir(modelId)
    if (existsSync(modelDir) && this.validateModelFiles(manifest, modelDir)) {
      this.updateState(modelId, 'ready')
      return
    }

    this.updateState(modelId, 'downloading', 0)

    const archivePath = join(this.modelsDir, `${modelId}.tar.bz2`)
    // Why: resume appends, so a leftover archive from a crashed run would corrupt the download.
    try {
      if (existsSync(archivePath)) {
        rmSync(archivePath)
      }
    } catch {
      // best-effort; the first (non-resumed) attempt truncates on write
    }
    let aborted = false
    const abortController = new AbortController()

    const handle: DownloadHandle = {
      abort: () => {
        aborted = true
        // Why: a stalled HTTPS request may never deliver another chunk, so tear it down immediately.
        abortController.abort()
      }
    }
    this.activeDownloads.set(modelId, handle)

    try {
      await this.downloadArchiveWithRetry(
        manifest.downloadUrl,
        archivePath,
        manifest.sizeBytes,
        modelId,
        () => aborted,
        abortController.signal
      )

      if (aborted) {
        this.cleanup(modelId, archivePath)
        return
      }

      await this.verifyArchiveSha256(archivePath, manifest.archiveSha256)

      if (aborted) {
        this.cleanup(modelId, archivePath)
        return
      }

      this.updateState(modelId, 'extracting')
      await this.extractArchive(archivePath, this.modelsDir, modelId, () => aborted)

      if (aborted) {
        this.cleanup(modelId, archivePath)
        return
      }

      if (!this.validateModelFiles(manifest, modelDir)) {
        // Why: some archives nest files in a subdir; scan one level down and move them up.
        await this.flattenNestedDir(modelDir, manifest)
      }

      if (aborted) {
        this.cleanup(modelId, archivePath)
        return
      }

      if (!this.validateModelFiles(manifest, modelDir)) {
        throw new Error('Model files missing after extraction')
      }

      this.updateState(modelId, 'ready')
    } catch (err) {
      if (!aborted) {
        console.error('[speech] Model download failed:', modelId, err)
        this.updateState(modelId, 'error', undefined, String(err))
      }
      this.cleanup(modelId, archivePath)
      if (!aborted) {
        // Why: the settings UI awaits this to surface failures; stay quiet on cancellation, rethrow real errors.
        throw err
      }
    } finally {
      this.activeDownloads.delete(modelId)
      try {
        if (existsSync(archivePath)) {
          rmSync(archivePath)
        }
      } catch {
        // best-effort archive cleanup
      }
    }
  }

  cancelDownload(modelId: string): void {
    const handle = this.activeDownloads.get(modelId)
    if (handle) {
      handle.abort()
      this.updateState(modelId, 'not-downloaded')
    }
  }

  async deleteModel(modelId: string): Promise<void> {
    await this.migrationReady
    if (!getCatalogModel(modelId)) {
      throw new Error(`Unknown model: ${modelId}`)
    }
    const manifest = getCatalogModel(modelId)
    if (!manifest || !isLocalSpeechModel(manifest)) {
      throw new Error(`Model does not support deletion: ${modelId}`)
    }
    this.cancelDownload(modelId)
    const modelDir = this.getModelDir(modelId)
    if (existsSync(modelDir)) {
      await rm(modelDir, { recursive: true, force: true })
    }
    // Why: also delete the pre-migration copy, or the next launch re-migrates it and resurrects the model.
    if (this.migrationSourceDir) {
      const sourceModelDir = this.getSafeModelDir(modelId, this.migrationSourceDir)
      if (existsSync(sourceModelDir)) {
        await rm(sourceModelDir, { recursive: true, force: true })
      }
    }
    this.modelStates.delete(modelId)
  }

  private updateState(
    modelId: string,
    status: SpeechModelStatus,
    progress?: number,
    error?: string
  ): void {
    const state: SpeechModelState = { id: modelId, status, progress, error }
    this.modelStates.set(modelId, state)
    // Why: notify on every state change (not just progress) so extracting/ready/error transitions reach the UI.
    const progressValue = progress ?? (status === 'extracting' ? 0.95 : -1)
    for (const callback of this.progressCallbacks) {
      callback(modelId, progressValue)
    }
  }

  private getPartialArchiveBytes(archivePath: string): number {
    try {
      return statSync(archivePath).size
    } catch {
      return 0
    }
  }

  private async downloadArchiveWithRetry(
    url: string,
    archivePath: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    let requestCount = 0
    let noProgressStreak = 0
    const totals: DownloadTotals = { totalBytes: expectedSize }
    for (;;) {
      requestCount += 1
      const offset = this.getPartialArchiveBytes(archivePath)
      // Why: transport can fail after the last byte hits disk; the SHA-256 check is the real completion test.
      if (offset === totals.totalBytes) {
        return
      }
      // Why: absolute backstop against a server that never lets the download finish.
      if (requestCount > MAX_TOTAL_DOWNLOAD_REQUESTS) {
        throw describeInterruptedDownload(
          new Error('too many download requests'),
          offset,
          totals.totalBytes,
          requestCount - 1
        )
      }
      try {
        // Why: restart from the canonical URL, not the last redirect, because signed CDN redirect URLs expire.
        await this.downloadFile(
          url,
          archivePath,
          expectedSize,
          modelId,
          isAborted,
          signal,
          0,
          offset,
          totals
        )
        const receivedBytes = this.getPartialArchiveBytes(archivePath)
        if (receivedBytes === totals.totalBytes) {
          return
        }
        if (receivedBytes > totals.totalBytes) {
          throw new Error(
            `Model download exceeded its expected size (${receivedBytes} of ${totals.totalBytes} bytes)`
          )
        }
        const incompleteResponse = new Error(
          `Model download response ended at ${receivedBytes} of ${totals.totalBytes} bytes`
        )
        if (receivedBytes > offset) {
          // Why: some proxies cap each range segment; request the next immediately and reset the stall counter.
          noProgressStreak = 0
          continue
        }
        const retryableIncompleteResponse = incompleteResponse as HttpStatusError
        retryableIncompleteResponse.retryable = true
        throw retryableIncompleteResponse
      } catch (err) {
        if (isAborted() || signal.aborted) {
          throw err
        }
        const receivedBytes = this.getPartialArchiveBytes(archivePath)
        if (receivedBytes === totals.totalBytes) {
          return
        }
        noProgressStreak = receivedBytes > offset ? 0 : noProgressStreak + 1
        if (!isRetryableDownloadError(err)) {
          throw err
        }
        // Why: give up only on a genuine stall; a download still advancing across drops keeps going.
        if (noProgressStreak >= MAX_NO_PROGRESS_ATTEMPTS) {
          throw describeInterruptedDownload(err, receivedBytes, totals.totalBytes, requestCount)
        }
        const retryAfterMs = (err as HttpStatusError).retryAfterMs
        if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
          const statusCode = (err as HttpStatusError).httpStatusCode
          throw new Error(
            `HTTP ${statusCode}; server requested retry after ${Math.ceil(retryAfterMs / 1_000)} seconds`
          )
        }
        console.warn(
          `[speech] Model download attempt ${requestCount} failed, retrying:`,
          modelId,
          err
        )
        await sleepUnlessAborted(
          retryAfterMs ??
            DOWNLOAD_RETRY_DELAYS_MS[
              Math.min(Math.max(0, noProgressStreak - 1), DOWNLOAD_RETRY_DELAYS_MS.length - 1)
            ],
          signal
        )
      }
    }
  }

  private downloadFile(
    url: string,
    dest: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal?: AbortSignal,
    redirectCount = 0,
    resumeOffset = 0,
    totals?: DownloadTotals
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'))
        return
      }

      let parsedUrl: URL
      try {
        parsedUrl = new URL(url)
      } catch {
        reject(new Error('Invalid download URL'))
        return
      }

      if (parsedUrl.protocol !== 'https:') {
        reject(new Error('Model downloads must use HTTPS'))
        return
      }

      let settled = false
      let request: Electron.ClientRequest | null = null
      let idleTimeout: ReturnType<typeof setTimeout> | null = null
      const onSignalAbort = (): void => {
        const activeRequest = request
        rejectOnce(new Error('Aborted'))
        activeRequest?.abort()
      }
      const clearIdleTimeout = (): void => {
        if (idleTimeout) {
          clearTimeout(idleTimeout)
          idleTimeout = null
        }
      }
      const cleanupRequestListeners = (): void => {
        const activeRequest = request
        clearIdleTimeout()
        if (!activeRequest) {
          return
        }
        activeRequest.off('error', onRequestError)
        activeRequest.off('response', onResponse)
        activeRequest.off('redirect', onRedirect)
        signal?.removeEventListener('abort', onSignalAbort)
        request = null
      }
      const resetIdleTimeout = (): void => {
        clearIdleTimeout()
        idleTimeout = setTimeout(onRequestTimeout, DOWNLOAD_IDLE_TIMEOUT_MS)
      }
      const resolveOnce = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanupRequestListeners()
        resolve()
      }
      const rejectOnce = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        cleanupRequestListeners()
        reject(error)
      }
      const onRequestError = (error: Error): void => rejectOnce(error)
      const onRequestTimeout = (): void => {
        const activeRequest = request
        rejectOnce(
          new Error(
            `Model download timed out after ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} seconds without network activity`
          )
        )
        activeRequest?.abort()
      }
      const onRedirect = (_statusCode: number, _method: string, redirectUrl: string): void => {
        if (redirectCount >= 5) {
          const activeRequest = request
          rejectOnce(new Error('Too many redirects'))
          activeRequest?.abort()
          return
        }
        let resolvedRedirect: URL
        try {
          resolvedRedirect = new URL(redirectUrl, parsedUrl)
        } catch {
          const activeRequest = request
          rejectOnce(new Error('Invalid redirect URL'))
          activeRequest?.abort()
          return
        }
        if (resolvedRedirect.protocol !== 'https:') {
          const activeRequest = request
          rejectOnce(new Error('Model download redirect must use HTTPS'))
          activeRequest?.abort()
          return
        }
        const activeRequest = request
        cleanupRequestListeners()
        activeRequest?.abort()
        this.downloadFile(
          resolvedRedirect.toString(),
          dest,
          expectedSize,
          modelId,
          isAborted,
          signal,
          redirectCount + 1,
          resumeOffset,
          totals
        )
          .then(resolveOnce)
          .catch(rejectOnce)
      }
      const onResponse = (incoming: Electron.IncomingMessage): void => {
        const response = incoming as DownloadIncomingMessage
        const contentLength = response.headers['content-length']
        const headerLength = Number.parseInt(getHeaderValue(contentLength) || '0', 10)
        const parsedLength =
          Number.isSafeInteger(headerLength) && headerLength > 0 ? headerLength : 0
        const contentRange = parseContentRange(response.headers['content-range'])
        const resumed =
          resumeOffset > 0 &&
          response.statusCode === 206 &&
          contentRange?.start === resumeOffset &&
          (parsedLength <= 0 || parsedLength === contentRange.end - contentRange.start + 1)

        if (resumeOffset > 0 && response.statusCode === 206 && !resumed) {
          // Why: appending an unverified range can silently corrupt the archive; discard and retry from byte zero.
          try {
            rmSync(dest)
          } catch {
            // best-effort
          }
          const activeRequest = request
          const rangeError: HttpStatusError = new Error(
            `Invalid Content-Range for resume at byte ${resumeOffset}`
          )
          rangeError.retryable = true
          rejectOnce(rangeError)
          activeRequest?.abort()
          return
        }

        if (response.statusCode !== 200 && !resumed) {
          if (response.statusCode === 416) {
            // Why: 416 means the server rejected our resume offset; drop the partial to restart from scratch.
            try {
              rmSync(dest)
            } catch {
              // best-effort
            }
          }
          const activeRequest = request
          const statusError: HttpStatusError = new Error(`HTTP ${response.statusCode}`)
          statusError.httpStatusCode = response.statusCode
          statusError.retryAfterMs = parseRetryAfterMs(response.headers['retry-after'])
          rejectOnce(statusError)
          // Why: abort so a retry doesn't leave the error-response body draining unowned.
          activeRequest?.abort()
          return
        }

        // Why: a 200 to our Range request means the server restarted from byte zero, so overwrite the partial.
        const progressBase = resumed ? resumeOffset : 0
        // Why: Content-Length on a 206 is only this segment; on Content-Range '*' keep the known full size.
        const totalSize = resumed
          ? (contentRange?.totalBytes ?? totals?.totalBytes ?? expectedSize)
          : parsedLength > 0
            ? parsedLength
            : expectedSize
        if (totals) {
          totals.totalBytes = totalSize
        }
        let downloaded = 0

        const fileStream = createWriteStream(dest, { flags: resumed ? 'a' : 'w' })

        const cleanupResponseProgressListener = (): void => {
          response.off('data', onResponseData)
        }
        const onResponseData = (chunk: Buffer): void => {
          resetIdleTimeout()
          if (isAborted()) {
            request?.abort()
            response.destroy?.()
            fileStream.destroy()
            return
          }
          downloaded += chunk.length
          const progress = Math.min(0.9, (progressBase + downloaded) / totalSize)
          this.updateState(modelId, 'downloading', progress)
        }

        response.on('data', onResponseData)
        pipeline(response, fileStream)
          .then(() => {
            cleanupResponseProgressListener()
            if (isAborted()) {
              rejectOnce(new Error('Aborted'))
            } else {
              resolveOnce()
            }
          })
          .catch((error: Error) => {
            cleanupResponseProgressListener()
            rejectOnce(error)
          })
      }

      request = net.request({ method: 'GET', url: parsedUrl.toString() })
      if (resumeOffset > 0) {
        request.setHeader('Range', `bytes=${resumeOffset}-`)
      }

      // Why: Electron net honors app proxy settings (unlike Node https) but exposes no setTimeout, so time out manually.
      resetIdleTimeout()
      request.on('error', onRequestError)
      request.on('response', onResponse)
      request.on('redirect', onRedirect)
      if (signal) {
        signal.addEventListener('abort', onSignalAbort, { once: true })
      }
      request.end()
    })
  }

  private verifyArchiveSha256(archivePath: string, expectedSha256: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(archivePath)
      let settled = false

      const cleanup = (): void => {
        stream.off('data', onData)
        stream.off('error', onError)
        stream.off('end', onEnd)
      }
      const settleResolve = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve()
      }
      const settleReject = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
      const onData = (chunk: Buffer): void => {
        hash.update(chunk)
      }
      const onError = (error: Error): void => {
        settleReject(error)
      }
      const onEnd = (): void => {
        const actualSha256 = hash.digest('hex')
        if (actualSha256 !== expectedSha256.toLowerCase()) {
          // Why: archives feed native parsers, so verify contents against compromised/redirected release assets.
          settleReject(new Error('Downloaded model archive failed integrity verification'))
          return
        }
        settleResolve()
      }

      stream.on('data', onData)
      stream.on('error', onError)
      stream.on('end', onEnd)
    })
  }

  private extractArchive(
    archivePath: string,
    destDir: string,
    modelId: string,
    isAborted: () => boolean
  ): Promise<void> {
    const modelDir = join(destDir, modelId)
    mkdirSync(modelDir, { recursive: true })

    return new Promise((resolve, reject) => {
      // Why: spawn (not exec) so slow bzip2 stderr can't overflow exec's 1MB maxBuffer and silently kill the process.
      const tarExecutable = resolveTarExecutable()
      const child = spawn(
        tarExecutable,
        ['-xjf', archivePath, '-C', modelDir, '--strip-components=1'],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true
        }
      )

      let stderr = ''
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | null = null
      let abortPoll: ReturnType<typeof setInterval> | null = null
      const cleanup = (): void => {
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        if (abortPoll) {
          clearInterval(abortPoll)
          abortPoll = null
        }
        child.stderr?.off('data', onStderrData)
        child.off('close', onClose)
        child.off('error', onError)
      }
      const fail = (error: Error, killChild = false): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (killChild) {
          child.kill('SIGKILL')
        }
        reject(error)
      }
      const onStderrData = (chunk: Buffer): void => {
        stderr += chunk.toString()
      }
      const onClose = (code: number | null): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`tar exited with code ${code}: ${stderr.slice(0, 500)}`))
        }
      }
      const onError = (err: Error): void => {
        fail(err)
      }

      child.stderr?.on('data', onStderrData)
      timeout = setTimeout(() => {
        fail(new Error('Extraction timed out after 10 minutes'), true)
      }, 600_000)
      abortPoll = setInterval(() => {
        if (isAborted()) {
          // Why: a wedged child may never emit close/error, so abort must kill it here.
          fail(new Error('Aborted'), true)
        }
      }, 250)

      child.on('close', onClose)
      child.on('error', onError)
    })
  }

  private async flattenNestedDir(modelDir: string, manifest: SpeechModelManifest): Promise<void> {
    if (!manifest.files) {
      return
    }
    const entries = await readdir(modelDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nestedDir = join(modelDir, entry.name)
        const nestedFiles = await readdir(nestedDir)
        const hasExpected = manifest.files.some((f) => nestedFiles.includes(f))
        if (hasExpected) {
          const { rename: fsRename } = await import('node:fs/promises')
          for (const file of nestedFiles) {
            await fsRename(join(nestedDir, file), join(modelDir, file))
          }
          await rm(nestedDir, { recursive: true, force: true })
          return
        }
      }
    }
  }

  private cleanup(modelId: string, archivePath: string): void {
    try {
      if (existsSync(archivePath)) {
        rmSync(archivePath)
      }
    } catch {
      // best-effort
    }
    const modelDir = this.getModelDir(modelId)
    try {
      if (existsSync(modelDir)) {
        rmSync(modelDir, { recursive: true })
      }
    } catch {
      // best-effort
    }
  }
}
