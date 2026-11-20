import { createHash } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deleteLocalSpeechModel } from '../speech/speech-model-deletion'
import {
  clearOpenAiSpeechApiKey,
  getOpenAiSpeechApiKeyProtection,
  hasOpenAiSpeechApiKey,
  saveOpenAiSpeechApiKey
} from '../speech/openai-api-key-store'
import { SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import type { SttEvent } from '../speech/stt-service'
import type { RuntimeStore } from './construction/runtime-store-contract'

export type RuntimeDesktopSpeechEvent =
  | { type: 'downloadProgress'; modelId: string; progress: number }
  | { type: 'ready' | 'stopped'; sessionId: string }
  | { type: 'partial' | 'final'; sessionId: string; text: string }
  | { type: 'error'; sessionId: string; error: string }

type Listener = (event: RuntimeDesktopSpeechEvent) => void
type ActiveDictation = {
  owner: string
  connectionId: string
  sessionId: string
  hotwordsPath?: string
  cleanupId: string
}

export class RuntimeDesktopSpeechController {
  private readonly listeners = new Set<Listener>()
  private progressUnsubscribe: (() => void) | null = null
  private active: ActiveDictation | null = null

  constructor(private readonly getStore: () => RuntimeStore) {}

  catalog() {
    return SPEECH_MODEL_CATALOG
  }

  modelStates() {
    return getSpeechModelManager(this.getStore()).getModelStates()
  }

  apiKeyStatus() {
    return { configured: hasOpenAiSpeechApiKey(), protection: getOpenAiSpeechApiKeyProtection() }
  }

  saveApiKey(apiKey: string) {
    saveOpenAiSpeechApiKey(apiKey)
    return { configured: true, protection: getOpenAiSpeechApiKeyProtection() }
  }

  clearApiKey() {
    clearOpenAiSpeechApiKey()
    return { configured: false, protection: null }
  }

  async downloadModel(modelId: string): Promise<void> {
    this.installProgressListener()
    await getSpeechModelManager(this.getStore()).downloadModel(modelId)
  }

  cancelDownload(modelId: string): void {
    getSpeechModelManager(this.getStore()).cancelDownload(modelId)
  }

  async deleteModel(modelId: string): Promise<void> {
    const store = this.getStore()
    await deleteLocalSpeechModel({
      store,
      modelManager: getSpeechModelManager(store),
      sttService: getSpeechSttService(store),
      modelId
    })
  }

  subscribe(listener: Listener): () => void {
    this.installProgressListener()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(
    connectionId: string,
    sessionId: string,
    modelId: string,
    hotwords: string[] | undefined,
    registerCleanup: (id: string, cleanup: () => void | Promise<void>) => void
  ): Promise<void> {
    if (this.active) {
      throw new Error('dictation_already_active')
    }
    const store = this.getStore()
    const manager = getSpeechModelManager(store)
    const state = await manager.getModelState(modelId)
    if (state.status !== 'ready') {
      throw new Error(`voice_model_not_ready:${state.status}`)
    }
    const owner = `desktop:${connectionId}:${sessionId}`
    const cleanupId = `speech.desktop.dictation:${connectionId}:${sessionId}`
    const hotwordsPath = await this.writeHotwords(manager.getModelsDir(), hotwords)
    const active: ActiveDictation = { owner, connectionId, sessionId, hotwordsPath, cleanupId }
    this.active = active
    registerCleanup(cleanupId, () => this.stop(connectionId, sessionId, false))
    try {
      await getSpeechSttService(store).startDictation(
        modelId,
        (event) => this.acceptEvent(active, event),
        hotwords?.map((term) => ({ term })),
        owner
      )
    } catch (error) {
      await this.finish(active)
      throw error
    }
  }

  feed(connectionId: string, sessionId: string, audioBase64: string, sampleRate: number): void {
    const active = this.requireActive(connectionId, sessionId)
    const bytes = Buffer.from(audioBase64, 'base64')
    if (bytes.length === 0 || bytes.length % 4 !== 0) {
      throw new Error('invalid_speech_audio')
    }
    const samples = new Float32Array(bytes.length / 4)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = bytes.readFloatLE(index * 4)
    }
    getSpeechSttService(this.getStore()).feedAudio(samples, sampleRate, active.owner)
  }

  async stop(connectionId: string, sessionId: string, unregister = true): Promise<void> {
    const active = this.active
    if (!active || active.connectionId !== connectionId || active.sessionId !== sessionId) {
      return
    }
    await getSpeechSttService(this.getStore()).stopDictation(active.owner)
    await this.finish(active)
    if (unregister) {
      // The RPC method owns the registry and calls cleanup after this returns.
      this.active = null
    }
  }

  private installProgressListener(): void {
    if (this.progressUnsubscribe) {
      return
    }
    this.progressUnsubscribe = getSpeechModelManager(this.getStore()).setProgressCallback(
      (modelId, progress) => this.publish({ type: 'downloadProgress', modelId, progress })
    )
  }

  private async writeHotwords(
    modelsDir: string,
    hotwords: string[] | undefined
  ): Promise<string | undefined> {
    if (!hotwords?.length) {
      return undefined
    }
    const content = `${hotwords.map((word) => `${word} :2.0`).join('\n')}\n`
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
    const path = join(modelsDir, `speech-hotwords-${digest}.txt`)
    await writeFile(path, content, 'utf8')
    return path
  }

  private acceptEvent(active: ActiveDictation, event: SttEvent): void {
    if (this.active !== active) {
      return
    }
    switch (event.type) {
      case 'ready':
      case 'stopped':
        this.publish({ type: event.type, sessionId: active.sessionId })
        break
      case 'partial':
      case 'final':
        this.publish({ type: event.type, sessionId: active.sessionId, text: event.text ?? '' })
        break
      case 'error':
        this.publish({ type: 'error', sessionId: active.sessionId, error: event.error ?? '' })
        break
    }
    if (event.type === 'stopped' || event.type === 'error') {
      void this.finish(active)
    }
  }

  private async finish(active: ActiveDictation): Promise<void> {
    if (this.active === active) {
      this.active = null
    }
    if (active.hotwordsPath) {
      await unlink(active.hotwordsPath).catch(() => undefined)
    }
  }

  private requireActive(connectionId: string, sessionId: string): ActiveDictation {
    const active = this.active
    if (!active || active.connectionId !== connectionId || active.sessionId !== sessionId) {
      throw new Error('dictation_owner_mismatch')
    }
    return active
  }

  private publish(event: RuntimeDesktopSpeechEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
