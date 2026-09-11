import { app } from 'electron'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type {
  SpeechModelManifest,
  SpeechModelState,
  SpeechModelStatus
} from '../../shared/speech-types'
import { SPEECH_MODEL_CATALOG, getCatalogModel, isLocalSpeechModel } from './model-catalog'
import { hasOpenAiSpeechApiKey } from './openai-api-key-store'
import {
  getSpeechModelCacheDirCandidates,
  migrateSpeechModelCacheIfNeeded,
  type SpeechModelCacheDir
} from './model-cache-path'
import { SpeechModelDownloadTransport } from './speech-model-download-transport'
import {
  removeModelDownloadFiles,
  removeModelDownloadStaging
} from './speech-model-download-cleanup'

type DownloadHandle = {
  abort: () => void
}

type ProgressCallback = (modelId: string, progress: number) => void

export class ModelManager extends SpeechModelDownloadTransport {
  private modelsDir: string
  private migrationSourceDir: string | null
  private migrationReady: Promise<void>
  private activeDownloads = new Map<string, DownloadHandle>()
  private modelStates = new Map<string, SpeechModelState>()
  private progressCallbacks = new Set<ProgressCallback>()

  constructor(customModelsDir?: string) {
    super()
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
    if (!manifest.downloadFiles) {
      return false
    }
    return manifest.downloadFiles.every(({ name, sizeBytes }) => {
      try {
        return statSync(join(modelDir, name)).size === sizeBytes
      } catch {
        return false
      }
    })
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
    if (!manifest.downloadFiles?.length || !manifest.sizeBytes) {
      throw new Error(`Model download metadata missing: ${modelId}`)
    }

    const modelDir = this.getModelDir(modelId)
    if (existsSync(modelDir) && this.validateModelFiles(manifest, modelDir)) {
      this.updateState(modelId, 'ready')
      return
    }

    this.updateState(modelId, 'downloading', 0)

    const stagingDir = `${modelDir}.partial`
    const legacyArchivePath = join(this.modelsDir, `${modelId}.tar.bz2`)
    // Why: resuming an unverified file left by a crashed process could preserve corrupt bytes.
    rmSync(stagingDir, { recursive: true, force: true })
    try {
      rmSync(legacyArchivePath, { force: true })
    } catch {
      // best-effort legacy cleanup
    }
    mkdirSync(stagingDir, { recursive: true })
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
      await this.downloadModelFiles(
        manifest,
        stagingDir,
        modelId,
        () => aborted,
        abortController.signal
      )

      if (aborted) {
        return
      }

      await rm(modelDir, { recursive: true, force: true })
      await rename(stagingDir, modelDir)
      this.updateState(modelId, 'ready')
    } catch (err) {
      if (!aborted) {
        console.error('[speech] Model download failed:', modelId, err)
        this.updateState(modelId, 'error', undefined, String(err))
      }
      removeModelDownloadFiles(modelDir, stagingDir, legacyArchivePath)
      if (!aborted) {
        // Why: the settings UI awaits this to surface failures; stay quiet on cancellation, rethrow real errors.
        throw err
      }
    } finally {
      this.activeDownloads.delete(modelId)
      removeModelDownloadStaging(stagingDir, legacyArchivePath)
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
    await rm(`${modelDir}.partial`, { recursive: true, force: true })
    await rm(join(this.modelsDir, `${modelId}.tar.bz2`), { force: true })
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
    const previous = this.modelStates.get(modelId)
    // Whole-percent state matches the UI and prevents chunk-level IPC/poll churn.
    const reportedProgress =
      status === 'downloading' && progress !== undefined
        ? Math.round(progress * 100) / 100
        : progress
    if (
      status === 'downloading' &&
      previous?.status === 'downloading' &&
      previous.error === error &&
      previous.progress === reportedProgress
    ) {
      return
    }
    const state: SpeechModelState = { id: modelId, status, progress: reportedProgress, error }
    this.modelStates.set(modelId, state)
    // Repeated non-download states can be the requesting window's only resync signal.
    const progressValue = reportedProgress ?? (status === 'extracting' ? 0.95 : -1)
    for (const callback of this.progressCallbacks) {
      callback(modelId, progressValue)
    }
  }

  private async downloadModelFiles(
    manifest: SpeechModelManifest,
    stagingDir: string,
    modelId: string,
    isAborted: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    if (!manifest.downloadFiles?.length || !manifest.sizeBytes) {
      throw new Error(`Model download metadata missing: ${modelId}`)
    }

    let completedBytes = 0
    for (const file of manifest.downloadFiles) {
      if (
        !file.name ||
        file.name === '.' ||
        file.name === '..' ||
        file.name.includes('/') ||
        file.name.includes('\\')
      ) {
        throw new Error(`Invalid model download filename: ${file.name}`)
      }
      const filePath = join(stagingDir, file.name)
      await this.downloadFileWithRetry(
        file.url,
        filePath,
        file.sizeBytes,
        modelId,
        isAborted,
        signal,
        completedBytes,
        manifest.sizeBytes
      )
      if (isAborted()) {
        return
      }
      await this.verifyFileSha256(filePath, file.sha256)
      completedBytes += file.sizeBytes
    }

    if (!this.validateModelFiles(manifest, stagingDir)) {
      throw new Error('Model files missing after download')
    }
  }

  protected reportDownloadProgress(modelId: string, progress: number): void {
    this.updateState(modelId, 'downloading', progress)
  }
}
