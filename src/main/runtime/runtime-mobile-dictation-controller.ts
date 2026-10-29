import { getDefaultVoiceSettings } from '../../shared/constants'
import { MOBILE_DICTATION_RECONNECT_GRACE_MS } from '../../shared/rpc-contract/speech-params'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import { getCatalogModel, isLocalSpeechModel } from '../speech/model-catalog'
import {
  hasLocalSpeechRecognizer,
  LOCAL_SPEECH_UNAVAILABLE_ERROR
} from '../speech/stt-worker-paths'
import type { RuntimeStore } from './runtime-store-contract'

type MobileDictationSession = {
  id: string
  owner: string
  clientId: string
  state: 'starting' | 'active' | 'closing'
  partialText: string
  finalTexts: string[]
  errors: string[]
  // Bumped by each transcript event; chunks arrive far more often, so replies carry text only after a bump or a second.
  textVersion: number
  reportedVersion: number
  reportedAt: number
  abandonTimer?: ReturnType<typeof setTimeout>
}

export class RuntimeMobileDictationController {
  private session: MobileDictationSession | null = null

  constructor(private readonly getStore: () => RuntimeStore | null) {}

  async start(params: {
    dictationId: string
    modelId?: string
    clientId?: string
  }): Promise<{ dictationId: string; modelId: string }> {
    const store = this.requireStore()
    const voice = store.getSettings().voice ?? getDefaultVoiceSettings()
    if (!voice.enabled) {
      throw new Error('voice_dictation_disabled')
    }
    const modelId = params.modelId || voice.sttModel
    if (!modelId) {
      throw new Error('voice_model_not_selected')
    }
    const manifest = getCatalogModel(modelId)
    if (manifest && isLocalSpeechModel(manifest) && !hasLocalSpeechRecognizer()) {
      throw new Error(LOCAL_SPEECH_UNAVAILABLE_ERROR)
    }
    const modelState = await getSpeechModelManager(store).getModelState(modelId)
    if (modelState.status !== 'ready') {
      throw new Error(`voice_model_not_ready:${modelState.status}`)
    }
    if (!params.clientId) {
      throw new Error('dictation_requires_mobile_client')
    }
    if (this.session?.clientId === params.clientId && this.session.state === 'active') {
      // A phone runs one dictation at a time, so its new start retires one it lost track of (app relaunch inside the grace).
      await this.stopSession(this.session, { discard: true })
    }
    if (this.session) {
      throw new Error('dictation_already_active')
    }

    const owner = `mobile:${params.dictationId}`
    this.session = {
      id: params.dictationId,
      owner,
      clientId: params.clientId,
      state: 'starting',
      partialText: '',
      finalTexts: [],
      errors: [],
      textVersion: 0,
      reportedVersion: 0,
      reportedAt: 0
    }
    try {
      await getSpeechSttService(store).startDictation(
        modelId,
        (event) => this.acceptEvent(params.dictationId, event),
        undefined,
        owner
      )
      if (this.session?.id !== params.dictationId) {
        throw new Error('dictation_canceled')
      }
      this.session.state = 'active'
      const session = this.session
      // Owned by the phone, not its socket; it streams continuously, so this long without a request means it is gone.
      session.abandonTimer = setTimeout(
        () => void this.stopSession(session, { discard: true }).catch(() => undefined),
        MOBILE_DICTATION_RECONNECT_GRACE_MS
      )
    } catch (error) {
      if (this.session?.id === params.dictationId) {
        this.session = null
      }
      throw error
    }
    return { dictationId: params.dictationId, modelId }
  }

  feed(params: {
    dictationId: string
    audioBase64: string
    sampleRate: number
    clientId?: string
  }): { dictationId: string; text?: string } {
    const session = this.requireOwnedSession(params)
    if (session.state !== 'active') {
      throw new Error('dictation_stream_closing')
    }
    if (session.errors.length > 0) {
      throw new Error(session.errors[0])
    }
    const pcm = Buffer.from(params.audioBase64, 'base64')
    const samples = new Float32Array(Math.floor(pcm.length / 2))
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = pcm.readInt16LE(i * 2) / 32768
    }
    getSpeechSttService(this.requireStore()).feedAudio(samples, params.sampleRate, session.owner)
    // The text so far lets the phone keep it if the connection never comes back; resent each second in case a reply was lost.
    const now = Date.now()
    if (session.reportedVersion === session.textVersion && now - session.reportedAt < 1000) {
      return { dictationId: params.dictationId }
    }
    session.reportedVersion = session.textVersion
    session.reportedAt = now
    return { dictationId: params.dictationId, text: transcriptOf(session) }
  }

  async finish(params: {
    dictationId: string
    clientId?: string
  }): Promise<{ dictationId: string; text: string }> {
    const session = this.requireOwnedSession(params)
    await this.stopSession(session, { discard: false })
    if (session.errors.length > 0) {
      throw new Error(session.errors[0])
    }
    return { dictationId: params.dictationId, text: transcriptOf(session) }
  }

  async cancel(params: {
    dictationId: string
    clientId?: string
  }): Promise<{ dictationId: string }> {
    const session = this.session
    if (session?.id === params.dictationId && session.clientId === params.clientId) {
      await this.stopSession(session, { discard: true })
    }
    return { dictationId: params.dictationId }
  }

  private acceptEvent(
    dictationId: string,
    event: { type: string; text?: string; error?: string }
  ): void {
    const session = this.session
    if (!session || session.id !== dictationId) {
      return
    }
    if (event.type === 'partial') {
      session.partialText = event.text ?? ''
      session.textVersion += 1
    } else if (event.type === 'final') {
      const text = event.text?.trim()
      if (text) {
        session.finalTexts.push(text)
        session.partialText = ''
        session.textVersion += 1
      }
    } else if (event.type === 'error') {
      session.errors.push(event.error ?? 'Speech worker error')
    }
  }

  private requireOwnedSession(params: {
    dictationId: string
    clientId?: string
  }): MobileDictationSession {
    const session = this.session
    if (!session || session.id !== params.dictationId) {
      throw new Error('dictation_stream_not_started')
    }
    if (session.clientId !== params.clientId) {
      throw new Error('dictation_owner_mismatch')
    }
    if (session.state === 'active') {
      session.abandonTimer?.refresh()
    }
    return session
  }

  // Only finish transcribes; text nobody will read must not hold the speech session.
  private async stopSession(
    session: MobileDictationSession,
    options: { discard: boolean }
  ): Promise<void> {
    clearTimeout(session.abandonTimer)
    session.state = 'closing'
    try {
      await getSpeechSttService(this.requireStore()).stopDictation(session.owner, options)
    } finally {
      if (this.session?.id === session.id) {
        this.session = null
      }
    }
  }

  private requireStore(): RuntimeStore {
    const store = this.getStore()
    if (!store) {
      throw new Error('voice_dictation_unavailable')
    }
    return store
  }
}

function transcriptOf(session: MobileDictationSession): string {
  return [...session.finalTexts, session.partialText].join(' ').trim()
}
