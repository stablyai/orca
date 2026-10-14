import type {
  VoiceControlAgentActivityEvent,
  VoiceControlExchangeSdpResult,
  VoiceControlStartResult,
  VoiceControlState,
  VoiceControlStateChangedEvent,
  VoiceControlToolActivityEvent,
  VoiceScreenSnapshot,
  VoiceTranscriptEntry
} from '../../shared/voice-control-types'

export type VoiceControlApi = {
  start: () => Promise<VoiceControlStartResult>
  exchangeSdp: (sessionId: string, offerSdp: string) => Promise<VoiceControlExchangeSdpResult>
  stop: (sessionId: string) => Promise<void>
  getState: () => Promise<{ state: VoiceControlState; sessionId: string | null }>
  /** Backfill for the transcript panel: the durable log's newest entries. */
  getTranscript: () => Promise<VoiceTranscriptEntry[]>
  /** The transcript panel's composer: typed/pasted text becomes a user turn. */
  sendUserText: (sessionId: string, text: string) => Promise<void>
  onStateChanged: (callback: (event: VoiceControlStateChangedEvent) => void) => () => void
  onToolActivity: (callback: (event: VoiceControlToolActivityEvent) => void) => () => void
  onAgentActivity: (callback: (event: VoiceControlAgentActivityEvent) => void) => () => void
  /** Live transcript entries (same feed as the durable log) for the transcript panel. */
  onTranscriptEntry: (callback: (entry: VoiceTranscriptEntry) => void) => () => void
  /** Main's describe_screen tool asking the owner window what is on screen. */
  onScreenSnapshotRequest: (callback: (requestId: string) => void) => () => void
  sendScreenSnapshot: (requestId: string, snapshot: VoiceScreenSnapshot) => void
  /** Main detected a system resume mid-session; the renderer must restart the WebRTC side. */
  onSystemResume: (callback: () => void) => () => void
}
