import type { VoiceControlErrorKind, VoiceControlState } from '../../shared/voice-control-types'
import { exchangeRealtimeSdpOffer } from './openai-realtime-sdp-exchange'
import { RealtimeResponseGate } from './realtime-response-gate'
import { RealtimeSidebandSocket } from './realtime-sideband-socket'
import { VoiceControlDormantWatch } from './voice-control-dormant-watch'
import { VoiceControlRealtimeError } from './voice-control-realtime-error'
import { formatVoiceRosterForInstructions } from './voice-control-roster'
import { mintCoordinatorSession } from './voice-control-session-mint'
import { routeVoiceControlSidebandEvent } from './voice-control-sideband-event-routing'
import type {
  LiveSession,
  PendingSession,
  VoiceControlServiceDeps
} from './voice-control-service-types'
import {
  traceVoiceStateTransition,
  traceVoiceTranscript,
  voiceControlGateObserver
} from './voice-control-tracing'

export type { VoiceControlServiceDeps } from './voice-control-service-types'

/**
 * One control session's lifecycle: mint → await the renderer's SDP offer → open the
 * sideband → live tool dispatch through the response gate. Secrets and all OpenAI HTTP
 * stay in this process; the renderer only ever sees SDP strings and UI events.
 */

/** Sideband classifications that prove the session is being used right now. */
const IDLE_RESET_KINDS = new Set(['user-transcript', 'agent-transcript', 'tool-call'])

export class VoiceControlService {
  private state: VoiceControlState = 'idle'
  private sessionId: string | null = null
  private pending: PendingSession | null = null
  private live: LiveSession | null = null
  /** Bumped by stop(); an async step that wakes up behind a stop must not touch state. */
  private generation = 0
  /** Follow-through past the hangup: ended sessions' mailboxes, watched until drained. */
  private readonly dormantWatch: VoiceControlDormantWatch

  constructor(private readonly deps: VoiceControlServiceDeps) {
    this.dormantWatch = new VoiceControlDormantWatch({
      openWatcher: deps.openDormantWatcher,
      emitWakeForReply: deps.emitWakeForReply,
      getLiveBackend: () => this.live?.backend ?? null
    })
  }

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
    const generation = this.generation
    const failure = await this.guard(async () => {
      this.transition('minting')
      const { clientSecret, roster } = await mintCoordinatorSession(this.deps, apiKey)
      if (generation !== this.generation) {
        // Stopped mid-mint; the stop already published idle. Drop the late mint.
        return
      }
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
    const generation = this.generation
    let failure: { kind: VoiceControlErrorKind; error: string } | null = null
    let answerSdp = ''
    failure = await this.guard(async () => {
      const exchange = await exchangeRealtimeSdpOffer(
        this.deps.http,
        pending.clientSecret.value,
        offerSdp
      )
      if (generation !== this.generation) {
        // Stopped mid-exchange; the stop already published idle. Drop the late answer.
        return
      }
      answerSdp = exchange.answerSdp
      await this.openSideband(sessionId, exchange.callId, generation)
      if (generation !== this.generation) {
        return
      }
      this.transition('live')
    })
    if (failure) {
      return failure
    }
    if (generation !== this.generation) {
      // Stopped while the exchange was in flight — the caller's session is gone.
      return { kind: 'unknown', error: 'voice_control_session_superseded' }
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
    // Why the placeholder everywhere durable: the composer is where users paste login
    // codes and tokens (the prompt says so). The live panel shows the real text, but
    // neither the trace file nor the durable log may keep it — a paste can't sit on
    // disk or be replayed into a later session.
    traceVoiceTranscript('user', '(typed message)')
    this.deps.recordTranscript(
      { ts: Date.now(), kind: 'user', text },
      { durableText: '(typed message)' }
    )
    this.noteActivity(sessionId)
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
    this.generation += 1
    // Read the ledger before the teardown disposes the backend that owns it.
    const outstanding = this.readOutstanding()
    // Synchronous, so nothing interleaves between the teardown and the transition.
    this.teardownLive()
    this.transition('stopping')
    this.deps.emitToolActivity({
      sessionId: this.sessionId ?? '',
      tool: 'session',
      detail: `control session ended (${reason})`
    })
    this.sessionId = null
    // Autonomous ends name themselves so the pill can say why the session is gone;
    // a user-initiated stop needs no explanation.
    this.transition(
      'idle',
      reason === 'idle-suspend' || reason === 'max-session-minutes' ? reason : undefined
    )
    if (outstanding) {
      this.dormantWatch.watch(outstanding.runId, outstanding.panes)
    }
  }

  /** The live backend's unfinished follow-through — null when nothing is owed. */
  private readOutstanding(): { runId: string; panes: string[] } | null {
    const backend = this.live?.backend
    if (!backend || !backend.hasOutstandingWork()) {
      return null
    }
    return { runId: backend.runId(), panes: backend.outstandingPanes() }
  }

  private async openSideband(sessionId: string, callId: string, generation: number): Promise<void> {
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
      onEvent: (event) => {
        const kind = routeVoiceControlSidebandEvent({
          sessionId,
          gate,
          backend: this.live?.backend ?? null,
          emitToolActivity: this.deps.emitToolActivity,
          recordTranscript: this.deps.recordTranscript,
          event
        })
        if (IDLE_RESET_KINDS.has(kind)) {
          this.noteActivity(sessionId)
        }
      },
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
    if (generation !== this.generation) {
      // Stopped while the socket was connecting — close it and leave state alone;
      // creating the backend and timers now would resurrect a dead session.
      sideband.close()
      return
    }
    const maxMinutes = this.deps.getSettings().maxSessionMinutes
    const hangupTimer =
      maxMinutes > 0
        ? setTimeout(() => void this.stop('max-session-minutes'), maxMinutes * 60_000)
        : null
    hangupTimer?.unref?.()
    const wakeMessages = this.dormantWatch.consumeWakeMessages()
    const backend = this.deps.createBackend({
      sessionId,
      gate,
      send: (event) => sideband.send(event),
      ...(wakeMessages.length > 0 ? { wakeMessages } : {})
    })
    this.live = { sessionId, callId, sideband, gate, backend, hangupTimer, idleTimer: null }
    this.pending = null
    backend.start()
    this.armIdleTimer(sessionId)
  }

  /** The idle-suspend budget restarts on real use — speech, a spoken answer, a tool call. */
  private noteActivity(sessionId: string): void {
    if (this.live?.sessionId !== sessionId) {
      return
    }
    this.armIdleTimer(sessionId)
  }

  private armIdleTimer(sessionId: string): void {
    const live = this.live
    if (!live || live.sessionId !== sessionId) {
      return
    }
    if (live.idleTimer) {
      clearTimeout(live.idleTimer)
      live.idleTimer = null
    }
    const idleMinutes = this.deps.getSettings().idleSuspendMinutes
    if (!(idleMinutes > 0)) {
      return
    }
    live.idleTimer = setTimeout(() => {
      if (this.live?.sessionId === sessionId) {
        void this.stop('idle-suspend')
      }
    }, idleMinutes * 60_000)
    live.idleTimer.unref?.()
  }

  private transition(state: VoiceControlState, endReason?: string): void {
    this.state = state
    traceVoiceStateTransition(state)
    this.deps.emitState({ sessionId: this.sessionId, state, ...(endReason ? { endReason } : {}) })
  }

  /** Runs `body`, converting any failure into the error state and a classified result. */
  private async guard(
    body: () => Promise<void>
  ): Promise<{ kind: VoiceControlErrorKind; error: string } | null> {
    const generation = this.generation
    try {
      await body()
      return null
    } catch (error) {
      if (generation !== this.generation) {
        // A stop superseded this step while it was in flight; the stop published idle
        // deliberately, and the late failure must not resurrect an error state.
        return null
      }
      const kind = error instanceof VoiceControlRealtimeError ? error.kind : 'unknown'
      const message = error instanceof Error ? error.message : String(error)
      await this.fail(kind, message)
      return { kind, error: message }
    }
  }

  private async fail(kind: VoiceControlErrorKind, message: string): Promise<void> {
    // An error-killed session with outstanding dispatches still owes follow-through.
    const outstanding = this.readOutstanding()
    this.teardownLive()
    this.state = 'error'
    this.deps.emitState({
      sessionId: this.sessionId,
      state: 'error',
      errorKind: kind,
      error: message
    })
    if (outstanding) {
      this.dormantWatch.watch(outstanding.runId, outstanding.panes)
    }
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
      if (live.idleTimer) {
        clearTimeout(live.idleTimer)
      }
      live.gate.dispose()
      live.backend.dispose()
      live.sideband.close()
    }
  }
}
