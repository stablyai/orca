import { app } from 'electron'
import { join, resolve, relative } from 'path'
import { existsSync, mkdirSync, createWriteStream, rmSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { get as httpsGet } from 'https'
import { get as httpGet, type IncomingMessage } from 'http'
import { pipeline } from 'stream/promises'
import { spawn } from 'child_process'
import type {
  SpeechModelManifest,
  SpeechModelState,
  SpeechModelStatus
} from '../../shared/speech-types'
import { SPEECH_MODEL_CATALOG, getCatalogModel } from './model-catalog'

type DownloadHandle = {
  abort: () => void
}

type ProgressCallback = (modelId: string, progress: number) => void

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

    const handle: DownloadHandle = {
      abort: () => {
        aborted = true
      }
    }
    this.activeDownloads.set(modelId, handle)

    try {
      await this.downloadFile(
        manifest.downloadUrl,
        archivePath,
        manifest.sizeBytes,
        modelId,
        () => aborted
      )

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
    isAborted: () => boolean
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const getter = url.startsWith('https') ? httpsGet : httpGet

      const request = getter(url, (response: IncomingMessage) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location
          if (!redirectUrl) {
            reject(new Error('Redirect without location'))
            return
          }
          this.downloadFile(redirectUrl, dest, expectedSize, modelId, isAborted)
            .then(resolve)
            .catch(reject)
          return
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10) || expectedSize
        let downloaded = 0

        const fileStream = createWriteStream(dest)

        response.on('data', (chunk: Buffer) => {
          if (isAborted()) {
            response.destroy()
            fileStream.close()
            return
          }
          downloaded += chunk.length
          const progress = Math.min(0.9, downloaded / totalSize)
          this.updateState(modelId, 'downloading', progress)
        })

        pipeline(response, fileStream)
          .then(() => {
            if (isAborted()) {
              reject(new Error('Aborted'))
            } else {
              resolve()
            }
          })
          .catch(reject)
      })

      request.on('error', reject)
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
      const child = spawn('tar', ['-xjf', archivePath, '-C', modelDir, '--strip-components=1'], {
        stdio: ['ignore', 'ignore', 'pipe']
      })

      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Extraction timed out after 10 minutes'))
      }, 600_000)
      const abortPoll = setInterval(() => {
        if (isAborted()) {
          child.kill('SIGKILL')
          reject(new Error('Aborted'))
        }
      }, 250)

      child.on('close', (code) => {
        clearTimeout(timeout)
        clearInterval(abortPoll)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`tar exited with code ${code}: ${stderr.slice(0, 500)}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        clearInterval(abortPoll)
        reject(err)
      })
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
