import type { MainHttpClient } from '../network/http-client'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import type {
  VoiceControlAgentActivityEvent,
  VoiceControlSettings,
  VoiceControlStateChangedEvent,
  VoiceControlToolActivityEvent
} from '../../shared/voice-control-types'
import type { MintedRealtimeClientSecret } from './openai-realtime-client-secret-mint'
import type { RealtimeResponseGate, ResponseGateObserver } from './realtime-response-gate'
import type { RealtimeSidebandSocket } from './realtime-sideband-socket'
import type { ControlMailboxMessage } from './voice-control-reply-pump'
import type { VoiceControlSessionBackend } from './voice-control-session-backend'
import type { VoiceTranscriptEntry } from './voice-control-transcript-log'

/** Seam surface of the voice control service — see the service for the lifecycle. */
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
    /** Replies that arrived while no session was live — spoken on start. */
    wakeMessages?: ControlMailboxMessage[]
  }) => VoiceControlSessionBackend
  /**
   * Watches an ended session's run mailbox so follow-through mail (an agent finishing
   * after the user stopped or the session idle-suspended) still surfaces. The mailbox
   * outlives the audio session; the watcher is what makes "I'll let you know when it's
   * done" survive the hangup.
   */
  openDormantWatcher?: (
    runId: string,
    onMessages: (messages: ControlMailboxMessage[]) => void
  ) => { stop(): void }
  /** Asks the owner window to restart voice control so a pending reply gets spoken. */
  emitWakeForReply?: () => void
  /** CLI binary name the coordinator prompt advertises (`orca`, or `orca-dev` in dev). */
  cliCommand: string
  /** Tail of the durable transcript — baked into the session as the coordinator's memory. */
  readRecentTranscript: () => VoiceTranscriptEntry[]
  /** Durable transcript sink — user/assistant lines are written here from the sideband.
   *  `durableText` replaces `text` in the persisted copy only; the live feed keeps the
   *  real text. Used so pasted secrets never reach disk or a later session's memory. */
  recordTranscript: (entry: VoiceTranscriptEntry, options?: { durableText?: string }) => void
  gateObserver?: ResponseGateObserver
  createSideband?: (
    apiKey: string,
    callId: string,
    handler: ConstructorParameters<typeof RealtimeSidebandSocket>[2]
  ) => Pick<RealtimeSidebandSocket, 'connect' | 'close'> & {
    send: (event: Record<string, unknown>) => void
  }
}

export type PendingSession = {
  sessionId: string
  clientSecret: MintedRealtimeClientSecret
}

export type LiveSession = {
  sessionId: string
  callId: string
  sideband: { send(event: Record<string, unknown>): void; close(): void }
  gate: RealtimeResponseGate
  backend: VoiceControlSessionBackend
  hangupTimer: ReturnType<typeof setTimeout> | null
  /** Suspend-after-silence timer; realtime audio bills per minute connected. */
  idleTimer: ReturnType<typeof setTimeout> | null
}
