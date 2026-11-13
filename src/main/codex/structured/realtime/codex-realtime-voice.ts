import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from '../session-lifecycle/codex-structured-session-state'
import { readRecord, readString } from '../../app-server/codex-item-field-readers'
import { readCodexVoiceInitialItems } from './codex-realtime-voice-context'
import { CodexVoiceSpokenHistory } from './codex-realtime-voice-spoken-history'
import { listV3Voices, offeredVoice } from './codex-realtime-voices'
import type {
  AgentSessionVoiceEndReason,
  AgentSessionVoiceEvent
} from '../../../../shared/agent-session/agent-session-voice-conversation'

const ANSWER_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_CAPTION_CHARS = 2_000
const MAX_TRACKED_CAPTIONS = 16

export type CodexRealtimeVoiceHandle = { stop: () => void }

type Caption = { role: 'user' | 'assistant'; text: string }

type Slot = {
  threadId: string
  connection: CodexAppServerConnection
  phase: 'starting' | 'active' | 'stopping'
  /** Cleared once the client is told the attempt ended; nothing reaches it afterwards. */
  emit: ((event: AgentSessionVoiceEvent) => void) | null
  answerTimer: ReturnType<typeof setTimeout> | null
  captions: Map<string, Caption>
  /** Codex refused our stop, so no requested close is coming; the next start asks again. */
  stopFailed: boolean
}

/**
 * One voice attempt per session and app-server connection. Codex's sdp/error/closed frames carry
 * only threadId, so attempts are fenced by order: every attempt ends with our own
 * `thread/realtime/stop`, whose `closed {reason: "requested"}` follows everything the core emitted
 * for that attempt. The slot stays occupied, refusing new starts, until that frame arrives or the
 * connection is gone.
 */
export class CodexRealtimeVoice {
  private readonly slots = new Map<string, Slot>()
  private readonly spoken = new CodexVoiceSpokenHistory()

  /** An open voice session is live work: the idle sweep must not stop its child. A child whose
   *  stop failed may be retired, which ends the attempt for certain. */
  confirmIdle(sessionId: string): Promise<'busy'> | undefined {
    const slot = this.slots.get(sessionId)
    return slot && !slot.stopFailed ? Promise.resolve('busy') : undefined
  }

  /** Adapter deps whose child-ended events also end that child's voice session. */
  endWithChildren(
    deps: CodexStructuredSessionAdapterDeps,
    liveConnection: (sessionId: string) => CodexAppServerConnection | undefined
  ): CodexStructuredSessionAdapterDeps {
    return {
      ...deps,
      onEvent: (event) => {
        if (event.type === 'ended') {
          this.releaseEnded(event.sessionId, liveConnection(event.sessionId))
        }
        deps.onEvent?.(event)
      }
    }
  }

  /** The voices this child accepts for the v3 session `start` opens. */
  async listVoices(
    session: Pick<CodexSession, 'connection' | 'ended'> | undefined
  ): Promise<string[] | null> {
    if (!session || session.ended || session.connection.closed) {
      return null
    }
    return listV3Voices(session.connection).catch(() => null)
  }

  start(
    session: Pick<CodexSession, 'threadId' | 'connection' | 'ended'> | undefined,
    input: {
      sessionId: string
      offerSdp: string
      voice?: string
      emit: (event: AgentSessionVoiceEvent) => void
    }
  ): CodexRealtimeVoiceHandle {
    const { sessionId } = input
    this.releaseEnded(sessionId, session?.connection)
    if (!session || session.ended || session.connection.closed) {
      input.emit({ type: 'refused', reason: 'not-running' })
      return { stop: () => {} }
    }
    const held = this.slots.get(sessionId)
    if (held) {
      if (held.stopFailed) {
        this.requestStop(sessionId, held)
      }
      input.emit({ type: 'refused', reason: 'busy' })
      return { stop: () => {} }
    }
    const { connection } = session
    const slot: Slot = {
      threadId: session.threadId,
      connection,
      phase: 'starting',
      emit: input.emit,
      answerTimer: null,
      captions: new Map(),
      stopFailed: false
    }
    this.slots.set(sessionId, slot)
    slot.answerTimer = setTimeout(
      () => this.finish(sessionId, slot, 'answer-timeout'),
      ANSWER_TIMEOUT_MS
    )
    const pending = () => this.slots.get(sessionId) === slot && slot.phase === 'starting'
    void Promise.all([
      readCodexVoiceInitialItems(connection, session.threadId, this.spoken.of(session.threadId)),
      offeredVoice(connection, input.voice)
    ])
      .then(([initialItems, voice]) => {
        // A stop while the history was read already answered; Codex never hears of this attempt.
        if (!pending()) {
          return
        }
        if (input.voice && !voice) {
          deliver(slot, { type: 'voice-unavailable', voice: input.voice })
        }
        return connection.request(
          'thread/realtime/start',
          {
            threadId: session.threadId,
            outputModality: 'audio',
            transport: { type: 'webrtc', sdp: input.offerSdp },
            version: 'v3',
            // Codex forwards the thread's own replies; Orca never appends text or speech itself.
            clientManagedHandoffs: false,
            // The default startup context reads other threads and the workspace tree.
            includeStartupContext: false,
            // A flush would start a turn after the user hung up.
            flushTranscriptTailOnSessionEnd: false,
            backendReasoningStatus: false,
            // Codex rejects a voice its v3 list lacks; without one it uses its configured default.
            ...(voice ? { voice } : {}),
            ...(initialItems.length > 0 ? { initialItems } : {})
          },
          { timeoutMs: REQUEST_TIMEOUT_MS }
        )
      })
      .catch((error: unknown) => {
        if (pending()) {
          deliver(slot, { type: 'error', message: errorMessage(error) })
          this.finish(sessionId, slot, 'error')
        }
      })
    return { stop: () => this.finish(sessionId, slot, 'requested') }
  }

  observe = (
    sessionId: string,
    connection: CodexAppServerConnection | null,
    method: string,
    params: unknown
  ): void => {
    const slot = this.slots.get(sessionId)
    const record = readRecord(params)
    if (
      !slot ||
      slot.connection !== connection ||
      readString(record, 'threadId') !== slot.threadId
    ) {
      return
    }
    if (method === 'thread/realtime/closed') {
      if (slot.phase === 'stopping') {
        if (readString(record, 'reason') === 'requested') {
          this.slots.delete(sessionId)
        }
        return
      }
      this.finish(
        sessionId,
        slot,
        readString(record, 'reason') === 'error' ? 'error' : 'transport-closed'
      )
      return
    }
    if (slot.phase === 'stopping') {
      return
    }
    if (method === 'thread/realtime/sdp') {
      const sdp = readString(record, 'sdp')
      if (slot.phase === 'starting' && sdp) {
        clearAnswerTimer(slot)
        slot.phase = 'active'
        deliver(slot, { type: 'answer', sdp })
      }
      return
    }
    if (method === 'thread/realtime/error') {
      deliver(slot, {
        type: 'error',
        message: readString(record, 'message') ?? 'Codex voice failed.'
      })
      this.finish(sessionId, slot, 'error')
      return
    }
    this.observeCaption(slot, method, record)
  }

  /** A child ended: its voice session went with it, but a newer child's attempt stays. */
  private releaseEnded(sessionId: string, live: CodexAppServerConnection | undefined): void {
    const slot = this.slots.get(sessionId)
    if (slot && (slot.connection.closed || slot.connection !== live)) {
      this.drop(sessionId)
    }
  }

  private drop(sessionId: string): void {
    const slot = this.slots.get(sessionId)
    if (!slot) {
      return
    }
    this.slots.delete(sessionId)
    clearAnswerTimer(slot)
    slot.phase = 'stopping'
    deliver(slot, { type: 'ended', reason: 'provider-exited' })
    slot.emit = null
  }

  private finish(sessionId: string, slot: Slot, reason: AgentSessionVoiceEndReason): void {
    if (this.slots.get(sessionId) !== slot || slot.phase === 'stopping') {
      return
    }
    clearAnswerTimer(slot)
    slot.phase = 'stopping'
    deliver(slot, { type: 'ended', reason })
    slot.emit = null
    if (slot.connection.closed) {
      this.slots.delete(sessionId)
      return
    }
    this.requestStop(sessionId, slot)
  }

  // Stop always answers with closed(requested), even when the core never started a session.
  private requestStop(sessionId: string, slot: Slot): void {
    slot.stopFailed = false
    slot.connection
      .request(
        'thread/realtime/stop',
        { threadId: slot.threadId },
        { timeoutMs: REQUEST_TIMEOUT_MS }
      )
      .catch(() => {
        if (this.slots.get(sessionId) !== slot) {
          return
        }
        if (slot.connection.closed) {
          this.slots.delete(sessionId)
        } else {
          slot.stopFailed = true
        }
      })
  }

  /** Item notifications are Codex's canonical transcript; the flat delta/done pair repeats them. */
  private observeCaption(slot: Slot, method: string, record: Record<string, unknown>): void {
    if (method === 'thread/realtime/item/transcript/delta') {
      const itemId = readString(record, 'itemId')
      const caption = itemId ? slot.captions.get(itemId) : undefined
      const delta = readString(record, 'delta')
      if (itemId && caption && delta) {
        caption.text = boundCaption(caption.text + delta)
        deliver(slot, { type: 'transcript', itemId, ...caption, final: false })
      }
      return
    }
    if (method !== 'thread/realtime/item/started' && method !== 'thread/realtime/item/completed') {
      return
    }
    const item = readRecord(record.item)
    const itemId = readString(item, 'id')
    const role = readString(item, 'role')
    if (
      readString(item, 'type') !== 'transcriptSegment' ||
      !itemId ||
      (role !== 'user' && role !== 'assistant')
    ) {
      return
    }
    const caption: Caption = { role, text: boundCaption(readString(item, 'text') ?? '') }
    const final = method === 'thread/realtime/item/completed'
    slot.captions.delete(itemId)
    if (final && caption.text) {
      this.spoken.remember(slot.threadId, { ...caption, atMs: Date.now() })
    }
    if (!final) {
      slot.captions.set(itemId, caption)
      for (const oldest of slot.captions.keys()) {
        if (slot.captions.size <= MAX_TRACKED_CAPTIONS) {
          break
        }
        slot.captions.delete(oldest)
      }
    }
    deliver(slot, { type: 'transcript', itemId, ...caption, final })
  }
}

/** A client that vanished must not keep the provider's session from being stopped. */
function deliver(slot: Slot, event: AgentSessionVoiceEvent): void {
  try {
    slot.emit?.(event)
  } catch {
    slot.emit = null
  }
}

function clearAnswerTimer(slot: Slot): void {
  if (slot.answerTimer !== null) {
    clearTimeout(slot.answerTimer)
    slot.answerTimer = null
  }
}

function boundCaption(text: string): string {
  return text.length > MAX_CAPTION_CHARS ? text.slice(-MAX_CAPTION_CHARS) : text
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
