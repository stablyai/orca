/* eslint-disable max-lines -- Why: model download, checksum, extraction, and cleanup share one state machine so progress/error transitions stay coupled. */
import { app, net } from 'electron'
import { join, resolve, relative } from 'path'
import { existsSync, mkdirSync, createWriteStream, createReadStream, rmSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import { spawn } from 'child_process'
import type {
  SpeechModelManifest,
  SpeechModelState,
  SpeechModelStatus
} from '../../shared/speech-types'
import { SPEECH_MODEL_CATALOG, getCatalogModel, isLocalSpeechModel } from './model-catalog'
import { hasOpenAiSpeechApiKey } from './openai-api-key-store'
import { resolveTarExecutable } from './tar-executable'

type DownloadHandle = {
  abort: () => void
}

type ProgressCallback = (modelId: string, progress: number) => void
type DownloadIncomingMessage = Electron.IncomingMessage &
  NodeJS.ReadableStream & {
    headers: Record<string, string | string[] | undefined>
    resume: () => void
    destroy?: () => void
  }

const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000

export class ModelManager {
  private modelsDir: string
  private activeDownloads = new Map<string, DownloadHandle>()
  private modelStates = new Map<string, SpeechModelState>()
  private progressCallbacks = new Set<ProgressCallback>()

  constructor(customModelsDir?: string) {
    this.modelsDir = customModelsDir || join(app.getPath('userData'), 'speech-models')
    mkdirSync(this.modelsDir, { recursive: true })
  }

  setProgressCallback(cb: ProgressCallback): () => void {
    // Why: concurrent settings windows can observe the same download; a
    // returned unsubscribe prevents one window from replacing another.
    this.progressCallbacks.add(cb)
    return () => {
      this.progressCallbacks.delete(cb)
    }
  }

  getModelsDir(): string {
    return this.modelsDir
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

  private getSafeModelDir(modelId: string): string {
    const manifest = getCatalogModel(modelId)
    if (!manifest) {
      throw new Error(`Unknown model: ${modelId}`)
    }
    const modelsRoot = resolve(this.modelsDir)
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
    let aborted = false
    const abortController = new AbortController()

    const handle: DownloadHandle = {
      abort: () => {
        aborted = true
        // Why: a stalled HTTPS request may never deliver another data chunk;
        // cancellation must tear down the request immediately.
        abortController.abort()
      }
    }
    this.activeDownloads.set(modelId, handle)

    try {
      await this.downloadFile(
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
        // Why: some archives nest files inside a subdirectory matching the
        // archive name. If the expected files aren't at the top-level model
        // dir, scan one level down and move them up.
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
        this.updateState(modelId, 'error', undefined, String(err))
      }
      this.cleanup(modelId, archivePath)
      if (!aborted) {
        // Why: the settings UI awaits this promise to show download failures;
        // cancellation stays quiet, but real failures must reach the caller.
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
    // Why: notify the renderer on every state change (not just download
    // progress) so the UI updates for extracting/ready/error transitions.
    const progressValue = progress ?? (status === 'extracting' ? 0.95 : -1)
    for (const callback of this.progressCallbacks) {
      callback(modelId, progressValue)
    }
  }

  private downloadFile(
    url: string,
    dest: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal?: AbortSignal,
    redirectCount = 0
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
          redirectCount + 1
        )
          .then(resolveOnce)
          .catch(rejectOnce)
      }
      const onResponse = (incoming: Electron.IncomingMessage): void => {
        const response = incoming as DownloadIncomingMessage
        if (response.statusCode !== 200) {
          response.resume()
          rejectOnce(new Error(`HTTP ${response.statusCode}`))
          return
        }

        const contentLength = response.headers['content-length']
        const totalSize =
          parseInt(Array.isArray(contentLength) ? contentLength[0] : contentLength || '0', 10) ||
          expectedSize
        let downloaded = 0

        const fileStream = createWriteStream(dest)

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
          const progress = Math.min(0.9, downloaded / totalSize)
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

      // Why: Electron's net stack honors app proxy settings, unlike Node's
      // https client, but it does not expose request.setTimeout().
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
          // Why: these archives feed native model parsers; filename checks do
          // not protect against compromised or redirected release assets.
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
      // Why: spawn instead of exec because exec buffers all stdout/stderr
      // (1MB default maxBuffer). bzip2 decompression is slow (~1-5 min for
      // 170MB archives) and exec can silently kill the process if stderr
      // exceeds the buffer. spawn streams output without buffering.
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
          // Why: if the extraction child wedges and never emits close/error,
          // the abort poller must still clear itself when we reject.
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
          const { rename: fsRename } = await import('fs/promises')
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
