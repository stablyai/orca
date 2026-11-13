import { getDefaultVoiceSettings } from '../../../shared/constants'
import { MOBILE_DICTATION_RECONNECT_GRACE_MS } from '../../../shared/rpc-contract/speech-params'
import { speechModelNotReadyError } from '../../../shared/speech-model-retirement'
import { getSpeechModelManager, getSpeechSttService } from '../../speech/speech-runtime-service'
import { getCatalogModel, isLocalSpeechModel } from '../../speech/model-catalog'
import {
  hasLocalSpeechRecognizer,
  LOCAL_SPEECH_UNAVAILABLE_ERROR
} from '../../speech/stt-worker-paths'
import {
  MobileDictationChunkOrder,
  type MobileDictationChunk
} from './mobile-dictation-chunk-order'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { hostDictationTerms } from './runtime-dictation-terms'
import { dictationTextSettingsFor } from '../../../shared/dictation-cleanup'
import type { DictationTerm } from '../../../shared/dictation-dictionary'
import { cleanUpDictatedText } from '../../speech/dictation-cleanup-service'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import {
  DictationTranscript,
  type DictationTranscriptSnapshot
} from '../../../shared/dictation-transcript'

type MobileDictationSession = {
  id: string
  owner: string
  clientId: string
  /** The dictionary it was transcribed with, which cleanup spells by too. */
  terms: DictationTerm[]
  state: 'starting' | 'active' | 'closing'
  transcript: DictationTranscript
  errors: string[]
  // Chunks arrive far more often than text changes, so replies carry text only after a new revision or a second.
  reportedRevision: number
  reportedAt: number
  chunkOrder: MobileDictationChunkOrder
  // Cloud audio past the upload cap is dropped, so the client should stop and insert what was kept.
  audioLimitReached: boolean
  abandonTimer?: ReturnType<typeof setTimeout>
}

export class RuntimeMobileDictationController {
  // One per phone (or web client); the speech service bounds how many run at once.
  private readonly sessions = new Map<string, MobileDictationSession>()

  constructor(private readonly getStore: () => RuntimeStore | null) {}

  async start(params: {
    dictationId: string
    modelId?: string
    worktreeId?: string
    clientId?: string
  }): Promise<{ dictationId: string; modelId: string; dedupesResentChunks: true }> {
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
      throw new Error(speechModelNotReadyError(modelState))
    }
    const clientId = params.clientId
    if (!clientId) {
      throw new Error('dictation_requires_mobile_client')
    }
    const previous = this.sessions.get(clientId)
    if (previous && previous.state !== 'closing') {
      // A phone runs one dictation at a time, so its new start retires one it lost track of (app relaunch inside the grace).
      await this.stopSession(previous, { discard: true })
    }

    const owner = `mobile:${clientId}:${params.dictationId}`
    const terms = hostDictationTerms(store, params.worktreeId)
    const session: MobileDictationSession = {
      id: params.dictationId,
      owner,
      clientId,
      terms,
      state: 'starting',
      transcript: new DictationTranscript(),
      errors: [],
      reportedRevision: 0,
      reportedAt: 0,
      chunkOrder: new MobileDictationChunkOrder(),
      audioLimitReached: false
    }
    this.sessions.set(clientId, session)
    try {
      await getSpeechSttService(store).startDictation(
        modelId,
        (event) => acceptEvent(session, event),
        terms,
        owner,
        dictationTextSettingsFor({ ...store.getSettings(), voice })
      )
      if (this.sessions.get(clientId) !== session) {
        throw new Error('dictation_canceled')
      }
      session.state = 'active'
      // Owned by the phone, not its socket; it streams continuously, so this long without a request means it is gone.
      session.abandonTimer = setTimeout(
        () => void this.stopSession(session, { discard: true }).catch(() => undefined),
        MOBILE_DICTATION_RECONNECT_GRACE_MS
      )
    } catch (error) {
      if (this.sessions.get(clientId) === session) {
        this.sessions.delete(clientId)
      }
      throw error
    }
    // Tells the phone it may resend chunks a drop left unanswered.
    return { dictationId: params.dictationId, modelId, dedupesResentChunks: true }
  }

  feed(params: {
    dictationId: string
    audioBase64: string
    sampleRate: number
    seq?: number
    clientId?: string
  }): { dictationId: string; audioLimitReached?: true } & Partial<DictationTranscriptSnapshot> {
    const session = this.requireOwnedSession(params)
    if (session.state !== 'active') {
      throw new Error('dictation_stream_closing')
    }
    if (session.errors.length > 0) {
      throw new Error(session.errors[0])
    }
    // Phones that send no seq never resend.
    const ready =
      params.seq === undefined ? [params] : session.chunkOrder.accept(params.seq, params)
    for (const chunk of ready) {
      this.feedChunk(session, chunk)
    }
    // Repeated on every reply, so a reply lost to a drop cannot hide it.
    const reply = session.audioLimitReached
      ? { dictationId: params.dictationId, audioLimitReached: true as const }
      : { dictationId: params.dictationId }
    // The text so far lets the phone keep it if the connection never comes back; resent each second in case a reply was lost.
    const now = Date.now()
    const { revision } = session.transcript
    if (session.reportedRevision === revision && now - session.reportedAt < 1000) {
      return reply
    }
    session.reportedRevision = revision
    session.reportedAt = now
    return { ...reply, ...session.transcript.snapshot() }
  }

  /** `agentEnv`: what AI cleanup runs the user's agent with, when it's on. */
  async finish(
    params: { dictationId: string; clientId?: string },
    agentEnv?: CommitMessageAgentEnvironmentResolvers
  ): Promise<{ dictationId: string; text: string }> {
    const session = this.requireOwnedSession(params)
    for (const chunk of session.chunkOrder.drain()) {
      this.feedChunk(session, chunk)
    }
    await this.stopSession(session, { discard: false })
    if (session.errors.length > 0) {
      throw new Error(session.errors[0])
    }
    const heard = session.transcript.snapshot().text
    // The phone waits out cleanup inside its finish deadline; on any failure it gets the words as heard.
    const store = this.requireStore()
    const cleaned = await cleanUpDictatedText(
      { text: heard, terms: session.terms },
      { getSettings: () => store.getSettings(), getAgentEnvResolvers: () => agentEnv }
    )
    return {
      dictationId: params.dictationId,
      text: cleaned.status === 'cleaned' ? cleaned.text : heard
    }
  }

  async cancel(params: {
    dictationId: string
    clientId?: string
  }): Promise<{ dictationId: string }> {
    const session = params.clientId ? this.sessions.get(params.clientId) : undefined
    if (session?.id === params.dictationId) {
      await this.stopSession(session, { discard: true })
    }
    return { dictationId: params.dictationId }
  }

  private feedChunk(session: MobileDictationSession, chunk: MobileDictationChunk): void {
    if (session.audioLimitReached) {
      return
    }
    const pcm = Buffer.from(chunk.audioBase64, 'base64')
    const samples = new Float32Array(Math.floor(pcm.length / 2))
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = pcm.readInt16LE(i * 2) / 32768
    }
    const speech = getSpeechSttService(this.requireStore())
    if (speech.feedAudio(samples, chunk.sampleRate, session.owner)) {
      session.audioLimitReached = true
    }
  }

  private requireOwnedSession(params: {
    dictationId: string
    clientId?: string
  }): MobileDictationSession {
    const session = params.clientId ? this.sessions.get(params.clientId) : undefined
    if (!session || session.id !== params.dictationId) {
      throw new Error('dictation_stream_not_started')
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
      if (this.sessions.get(session.clientId) === session) {
        this.sessions.delete(session.clientId)
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

function acceptEvent(
  session: MobileDictationSession,
  event: { type: string; text?: string; error?: string }
): void {
  if (event.type === 'error') {
    session.errors.push(event.error ?? 'Speech worker error')
  } else {
    session.transcript.accept(event)
  }
}
