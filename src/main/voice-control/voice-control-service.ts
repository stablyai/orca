import type { MainHttpClient } from '../network/http-client'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import type {
  VoiceControlAgentActivityEvent,
  VoiceControlErrorKind,
  VoiceControlSettings,
  VoiceControlState,
  VoiceControlStateChangedEvent,
  VoiceControlToolActivityEvent
} from '../../shared/voice-control-types'
import {
  mintRealtimeClientSecret,
  type MintedRealtimeClientSecret
} from './openai-realtime-client-secret-mint'
import { exchangeRealtimeSdpOffer } from './openai-realtime-sdp-exchange'
import { classifyRealtimeEvent, MalformedToolCallError } from './realtime-event-classification'
import { RealtimeResponseGate, type ResponseGateObserver } from './realtime-response-gate'
import { RealtimeSidebandSocket } from './realtime-sideband-socket'
import { VoiceControlRealtimeError } from './voice-control-realtime-error'
import { buildCoordinatorInstructions } from './voice-control-coordinator-prompt'
import { formatVoiceRosterForInstructions, projectVoiceRoster } from './voice-control-roster'
import { COORDINATOR_TOOLS } from './voice-control-tool-schemas'
import {
  traceVoiceSidebandEvent,
  traceVoiceStateTransition,
  traceVoiceTranscript,
  voiceControlGateObserver
} from './voice-control-tracing'
import type { VoiceControlSessionBackend } from './voice-control-session-backend'
import type { VoiceTranscriptEntry } from './voice-control-transcript-log'

/**
 * One control session's lifecycle: mint → await the renderer's SDP offer → open the
 * sideband → live tool dispatch through the response gate. Secrets and all OpenAI HTTP
 * stay in this process; the renderer only ever sees SDP strings and UI events.
 */

export type VoiceControlServiceDeps = {
  http: Pick<MainHttpClient, 'fetch'>
  hasApiKey: () => boolean
  readApiKey: () => string
  getRoster: () => Promise<RuntimeWorktreePsSummary[]>
  getSettings: () => VoiceControlSettings
  emitState: (event: VoiceControlStateChangedEvent) => void
  emitToolActivity: (event: VoiceControlToolActivityEvent) => void
  emitAgentActivity: (event: VoiceControlAgentActivityEvent) => void
  /** Builds the per-session orchestration backend (run, pump, sequencer, watchdog). */
  createBackend: (args: {
    sessionId: string
    gate: RealtimeResponseGate
    send: (event: Record<string, unknown>) => void
  }) => VoiceControlSessionBackend
  /** CLI binary name the coordinator prompt advertises (`orca`, or `orca-dev` in dev). */
  cliCommand: string
  /** Tail of the durable transcript — baked into the session as the coordinator's memory. */
  readRecentTranscript: () => VoiceTranscriptEntry[]
  /** Durable transcript sink — user/assistant lines are written here from the sideband. */
  recordTranscript: (entry: VoiceTranscriptEntry) => void
  gateObserver?: ResponseGateObserver
  createSideband?: (
    apiKey: string,
    callId: string,
    handler: ConstructorParameters<typeof RealtimeSidebandSocket>[2]
  ) => Pick<RealtimeSidebandSocket, 'connect' | 'close'> & {
    send: (event: Record<string, unknown>) => void
  }
}

type PendingSession = {
  sessionId: string
  clientSecret: MintedRealtimeClientSecret
}

type LiveSession = {
  sessionId: string
  callId: string
  sideband: { send(event: Record<string, unknown>): void; close(): void }
  gate: RealtimeResponseGate
  backend: VoiceControlSessionBackend
  hangupTimer: ReturnType<typeof setTimeout> | null
}

export class VoiceControlService {
  private state: VoiceControlState = 'idle'
  private sessionId: string | null = null
  private pending: PendingSession | null = null
  private live: LiveSession | null = null

  constructor(private readonly deps: VoiceControlServiceDeps) {}

  getState(): { state: VoiceControlState; sessionId: string | null } {
    return { state: this.state, sessionId: this.sessionId }
  }

  async start(sessionId: string): Promise<{ kind: VoiceControlErrorKind; error: string } | null> {
    if (this.state !== 'idle') {
      return { kind: 'unknown', error: 'voice_control_already_active' }
    }
    if (!this.deps.hasApiKey()) {
      return { kind: 'key-missing', error: 'OpenAI API key is not configured' }
    }
    let apiKey: string
    try {
      apiKey = this.deps.readApiKey()
    } catch {
      // The blob can exist but be unreadable (sealed under another app's Keychain
      // identity, e.g. dev vs prod) — hasApiKey is existence-only, so classify here.
      return { kind: 'key-unreadable', error: 'OpenAI API key could not be decrypted' }
    }
    this.sessionId = sessionId
    const failure = await this.guard(async () => {
      this.transition('minting')
      const roster = projectVoiceRoster(await this.deps.getRoster())
      const settings = this.deps.getSettings()
      const clientSecret = await mintRealtimeClientSecret(this.deps.http, apiKey, {
        instructions: buildCoordinatorInstructions({
          roster,
          coordinatorVoice: settings.coordinatorVoice,
          customInstructions: settings.customInstructions,
          cli: this.deps.cliCommand,
          recentHistory: this.deps.readRecentTranscript()
        }),
        tools: COORDINATOR_TOOLS,
        voice: settings.coordinatorVoice
      })
      this.pending = { sessionId, clientSecret }
      this.transition('awaiting-sdp')
      this.deps.emitToolActivity({
        sessionId,
        tool: 'roster',
        detail: formatVoiceRosterForInstructions(roster)
      })
    })
    return failure
  }

  async exchangeSdp(
    sessionId: string,
    offerSdp: string
  ): Promise<{ answerSdp: string } | { kind: VoiceControlErrorKind; error: string }> {
    if (this.state !== 'awaiting-sdp' || this.pending?.sessionId !== sessionId) {
      return { kind: 'unknown', error: 'voice_control_no_pending_session' }
    }
    const pending = this.pending
    let failure: { kind: VoiceControlErrorKind; error: string } | null = null
    let answerSdp = ''
    failure = await this.guard(async () => {
      const exchange = await exchangeRealtimeSdpOffer(
        this.deps.http,
        pending.clientSecret.value,
        offerSdp
      )
      answerSdp = exchange.answerSdp
      await this.openSideband(sessionId, exchange.callId)
      this.transition('live')
    })
    if (failure) {
      return failure
    }
    return { answerSdp }
  }

  /**
   * Typed input from the transcript panel's composer: the same input_text a spoken turn
   * becomes, so the model can't tell (and doesn't need to). Recorded as a user line on
   * the same transcript feed as speech. Live sessions only — a minting session has no
   * conversation to append to.
   */
  sendUserText(sessionId: string, text: string): boolean {
    const live = this.live
    if (!live || this.sessionId !== sessionId || this.state !== 'live') {
      return false
    }
    traceVoiceTranscript('user', text)
    this.deps.recordTranscript({ ts: Date.now(), kind: 'user', text })
    live.gate.sendEvent({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    })
    live.gate.sendEvent({ type: 'response.create' })
    return true
  }

  async stop(reason = 'user'): Promise<void> {
    if (this.state === 'idle') {
      return
    }
    // Synchronous, so nothing interleaves between the teardown and the transition.
    this.teardownLive()
    this.transition('stopping')
    this.deps.emitToolActivity({
      sessionId: this.sessionId ?? '',
      tool: 'session',
      detail: `control session ended (${reason})`
    })
    this.sessionId = null
    this.transition('idle')
  }

  private async openSideband(sessionId: string, callId: string): Promise<void> {
    const createSideband =
      this.deps.createSideband ??
      ((
        apiKey: string,
        id: string,
        handler: ConstructorParameters<typeof RealtimeSidebandSocket>[2]
      ) => new RealtimeSidebandSocket(apiKey, id, handler))
    let sidebandRef: LiveSession['sideband'] | null = null
    const gate = new RealtimeResponseGate(
      (event) => sidebandRef?.send(event),
      this.deps.gateObserver ?? voiceControlGateObserver
    )
    const sideband = createSideband(this.deps.readApiKey(), callId, {
      onEvent: (event) => this.handleSidebandEvent(sessionId, gate, event),
      onMalformedFrame: () => {
        this.deps.emitToolActivity({
          sessionId,
          tool: 'sideband',
          detail: 'skipped a malformed sideband frame'
        })
      },
      onEnded: (reason, detail) => {
        if (this.live?.sessionId === sessionId && this.state === 'live') {
          void this.fail('network', `sideband ended (${reason}: ${detail})`)
        }
      }
    })
    sidebandRef = sideband
    await sideband.connect()
    const maxMinutes = this.deps.getSettings().maxSessionMinutes
    const hangupTimer =
      maxMinutes > 0
        ? setTimeout(() => void this.stop('max-session-minutes'), maxMinutes * 60_000)
        : null
    hangupTimer?.unref?.()
    const backend = this.deps.createBackend({
      sessionId,
      gate,
      send: (event) => sideband.send(event)
    })
    this.live = { sessionId, callId, sideband, gate, backend, hangupTimer }
    this.pending = null
    backend.start()
  }

  private handleSidebandEvent(
    sessionId: string,
    gate: RealtimeResponseGate,
    event: Record<string, unknown>
  ): void {
    gate.observe(event)
    // Provider-side records: rejections of non-create events (a refused injection reads
    // as a silent model otherwise), note-injection acks, and response end states.
    traceVoiceSidebandEvent(event)
    let classified
    try {
      classified = classifyRealtimeEvent(event)
    } catch (error) {
      if (error instanceof MalformedToolCallError) {
        // Why surfaced, not skipped: one bad frame on a healthy connection must be
        // visible; the session continues (otto-voice posture).
        this.deps.emitToolActivity({
          sessionId,
          tool: 'sideband',
          detail: `malformed tool call frame (${error.toolCallId ?? 'no call id'})`
        })
        return
      }
      throw error
    }
    this.live?.backend.observeEvent(event)
    if (classified.kind === 'tool-call') {
      void this.live?.backend.dispatchToolCall(
        classified.name,
        classified.argumentsJson,
        classified.toolCallId
      )
    } else if (classified.kind === 'user-transcript') {
      traceVoiceTranscript('user', classified.text)
      this.deps.recordTranscript({ ts: Date.now(), kind: 'user', text: classified.text })
    } else if (classified.kind === 'agent-transcript') {
      traceVoiceTranscript('assistant', classified.text)
      this.deps.recordTranscript({ ts: Date.now(), kind: 'assistant', text: classified.text })
    }
  }

  private transition(state: VoiceControlState): void {
    this.state = state
    traceVoiceStateTransition(state)
    this.deps.emitState({ sessionId: this.sessionId, state })
  }

  /** Runs `body`, converting any failure into the error state and a classified result. */
  private async guard(
    body: () => Promise<void>
  ): Promise<{ kind: VoiceControlErrorKind; error: string } | null> {
    try {
      await body()
      return null
    } catch (error) {
      const kind = error instanceof VoiceControlRealtimeError ? error.kind : 'unknown'
      const message = error instanceof Error ? error.message : String(error)
      await this.fail(kind, message)
      return { kind, error: message }
    }
  }

  private async fail(kind: VoiceControlErrorKind, message: string): Promise<void> {
    this.teardownLive()
    this.state = 'error'
    this.deps.emitState({
      sessionId: this.sessionId,
      state: 'error',
      errorKind: kind,
      error: message
    })
  }

  /** Drops the live session: hangup timer, backend, sideband — plus any pending mint. */
  private teardownLive(): void {
    const live = this.live
    this.live = null
    this.pending = null
    if (live) {
      if (live.hangupTimer) {
        clearTimeout(live.hangupTimer)
      }
      live.backend.dispose()
      live.sideband.close()
    }
  }
}
