/* eslint-disable max-lines -- Why: model download, checksum, extraction, and cleanup share one state machine so progress/error transitions stay coupled. */
import { app } from 'electron'
import { join, resolve, relative } from 'path'
import { existsSync, mkdirSync, createWriteStream, createReadStream, rmSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { get as httpsGet } from 'https'
import type { IncomingMessage } from 'http'
import { pipeline } from 'stream/promises'
import { spawn } from 'child_process'
import type {
  SpeechModelManifest,
  SpeechModelState,
  SpeechModelStatus
} from '../../shared/speech-types'
import { SPEECH_MODEL_CATALOG, getCatalogModel } from './model-catalog'
import { resolveTarExecutable } from './tar-executable'

type DownloadHandle = {
  abort: () => void
}

type ProgressCallback = (modelId: string, progress: number) => void

const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000

export class ModelManager {
  private modelsDir: string
  private activeDownloads = new Map<string, DownloadHandle>()
  private modelStates = new Map<string, SpeechModelState>()
  private progressCallback: ProgressCallback | null = null

  constructor(customModelsDir?: string) {
    this.modelsDir = customModelsDir || join(app.getPath('userData'), 'speech-models')
    mkdirSync(this.modelsDir, { recursive: true })
  }

  setProgressCallback(cb: ProgressCallback): void {
    this.progressCallback = cb
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
    this.progressCallback?.(modelId, progress ?? (status === 'extracting' ? 0.95 : -1))
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
      let request: ReturnType<typeof httpsGet> | null = null
      const cleanupRequestListeners = (): void => {
        const activeRequest = request
        if (!activeRequest) {
          return
        }
        activeRequest.off('error', onRequestError)
        activeRequest.off('timeout', onRequestTimeout)
        request = null
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
        activeRequest?.destroy()
      }
      const onResponse = (response: IncomingMessage): void => {
        if (
          response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 303 ||
          response.statusCode === 307 ||
          response.statusCode === 308
        ) {
          const redirectUrl = response.headers.location
          if (!redirectUrl) {
            response.resume()
            rejectOnce(new Error('Redirect without location'))
            return
          }
          if (redirectCount >= 5) {
            response.resume()
            rejectOnce(new Error('Too many redirects'))
            return
          }
          let resolvedRedirect: URL
          try {
            resolvedRedirect = new URL(redirectUrl, parsedUrl)
          } catch {
            response.resume()
            rejectOnce(new Error('Invalid redirect URL'))
            return
          }
          if (resolvedRedirect.protocol !== 'https:') {
            response.resume()
            rejectOnce(new Error('Model download redirect must use HTTPS'))
            return
          }
          response.resume()
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
          return
        }

        if (response.statusCode !== 200) {
          response.resume()
          rejectOnce(new Error(`HTTP ${response.statusCode}`))
          return
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10) || expectedSize
        let downloaded = 0

        const fileStream = createWriteStream(dest)

        const cleanupResponseProgressListener = (): void => {
          response.off('data', onResponseData)
        }
        const onResponseData = (chunk: Buffer): void => {
          if (isAborted()) {
            request?.destroy(new Error('Aborted'))
            response.destroy()
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

      request = signal
        ? httpsGet(parsedUrl, { signal }, onResponse)
        : httpsGet(parsedUrl, onResponse)

      // Why: cancellation only helps after the user presses cancel; a peer
      // that accepts the socket and goes silent must not leave the model stuck
      // in "downloading" forever.
      request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, onRequestTimeout)
      request.on('error', onRequestError)
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
