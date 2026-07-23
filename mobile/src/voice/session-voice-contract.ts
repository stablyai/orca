/**
 * M0 — Orca per-session voice contract (session-picker FAB).
 *
 * Source plan: meshina raw/research/2026-07-22-orca-per-session-voice-latency-plan.md §6 M0
 * + plans/active/2026-07-20-orca-mobile-voice-pet-canvas.md A2 correction.
 *
 * M1 consumes these types for FAB chooser + inject. Do not reimplement STT here —
 * useMobileDictation remains the STT path.
 */

/** How the mic is armed after a session is chosen. */
export type VoiceMicMode = 'hold-to-talk' | 'toggle'

/** Fast = small LLM / no tools; agent = real session agent (tools allowed). */
export type VoiceBrainLane = 'fast' | 'agent'

/** Where TTS audio is produced. Default mesh until on-device Kokoro ships (M2). */
export type VoiceTtsBackend = 'mesh' | 'on-device' | 'off'

/** Where STT runs. Default on-device (native Parakeet). */
export type VoiceSttBackend = 'on-device' | 'mesh'

/**
 * One voice-capable target in the FAB chooser.
 * Only Orca mother sessions for now (operator lock 2026-07-22).
 */
export type VoiceSessionCapability = {
  /** Stable id for inject + settings (worktreeId / session key). */
  sessionId: string
  /** Host / mother id (Orca host panel). */
  hostId: string
  /** Optional worktree binding when session is a worktree TUI. */
  worktreeId?: string
  /** Human label in chooser. */
  label: string
  /** Session accepts transcript inject. */
  acceptsInject: boolean
  /** Session supports TTS-back of assistant replies. */
  acceptsTtsBack: boolean
  /** Prefer fast vs agent lane when user has not overridden. */
  defaultLane: VoiceBrainLane
  /** Optional per-session Kokoro (or later) voice id. */
  voiceId?: string
  /** Kind for filtering — mother sessions only in M0/M1. */
  kind: 'orca-mother-session' | 'herm-narrator' | 'workspace'
}

/** Operator prefs (settings + per-session overrides). */
export type VoiceSessionSettings = {
  micMode: VoiceMicMode
  sttBackend: VoiceSttBackend
  ttsBackend: VoiceTtsBackend
  /** Default brain lane when capability has no override. */
  defaultLane: VoiceBrainLane
  /** Spoken confirm on tool use (operator lock: all tools). */
  spokenConfirmTools: boolean
  /** Global mute TTS-back. */
  ttsMuted: boolean
  /** Optional default voice id for mesh/on-device Kokoro. */
  defaultVoiceId?: string
}

export const DEFAULT_VOICE_SESSION_SETTINGS: VoiceSessionSettings = {
  micMode: 'hold-to-talk',
  sttBackend: 'on-device',
  ttsBackend: 'mesh',
  defaultLane: 'agent',
  spokenConfirmTools: true,
  ttsMuted: false
}

/**
 * Attach a finalized transcript to a chosen session (inject path).
 * Wire = text over Tailscale, not audio.
 */
export type VoiceAttach = {
  type: 'voice.attach'
  /** Idempotency / correlation. */
  requestId: string
  sessionId: string
  hostId: string
  worktreeId?: string
  mode: VoiceBrainLane
  transcript: string
  /** ISO-8601 when STT finalized on device. */
  sttFinalizedAt: string
  micMode: VoiceMicMode
  sttBackend: VoiceSttBackend
}

/** Ask Herm narrator about a session without interrupting its agent (A2b). */
export type VoiceNarratorAsk = {
  type: 'voice.narrator_ask'
  requestId: string
  hostId: string
  /** Session being discussed (context), not necessarily inject target. */
  aboutSessionId: string
  transcript: string
  sttFinalizedAt: string
}

/** TTS-back request after assistant text is ready (M2 consumes). */
export type VoiceSpeakBack = {
  type: 'voice.speak_back'
  requestId: string
  sessionId: string
  hostId: string
  text: string
  ttsBackend: VoiceTtsBackend
  voiceId?: string
  /** When true, this is an immediate ACK ("On it.") not the full answer. */
  isAck?: boolean
}

export type VoiceContractMessage = VoiceAttach | VoiceNarratorAsk | VoiceSpeakBack

export function isNonEmptyTranscript(s: string): boolean {
  return s.trim().length > 0
}

export function validateVoiceAttach(msg: VoiceAttach): string[] {
  const errs: string[] = []
  if (msg.type !== 'voice.attach') {
    errs.push('type')
  }
  if (!msg.requestId?.trim()) {
    errs.push('requestId')
  }
  if (!msg.sessionId?.trim()) {
    errs.push('sessionId')
  }
  if (!msg.hostId?.trim()) {
    errs.push('hostId')
  }
  if (!isNonEmptyTranscript(msg.transcript)) {
    errs.push('transcript')
  }
  if (msg.mode !== 'fast' && msg.mode !== 'agent') {
    errs.push('mode')
  }
  if (msg.micMode !== 'hold-to-talk' && msg.micMode !== 'toggle') {
    errs.push('micMode')
  }
  if (msg.sttBackend !== 'on-device' && msg.sttBackend !== 'mesh') {
    errs.push('sttBackend')
  }
  if (!msg.sttFinalizedAt?.trim()) {
    errs.push('sttFinalizedAt')
  }
  return errs
}

export function validateVoiceSessionCapability(c: VoiceSessionCapability): string[] {
  const errs: string[] = []
  if (!c.sessionId?.trim()) {
    errs.push('sessionId')
  }
  if (!c.hostId?.trim()) {
    errs.push('hostId')
  }
  if (!c.label?.trim()) {
    errs.push('label')
  }
  if (c.defaultLane !== 'fast' && c.defaultLane !== 'agent') {
    errs.push('defaultLane')
  }
  const kinds = ['orca-mother-session', 'herm-narrator', 'workspace'] as const
  if (!kinds.includes(c.kind)) {
    errs.push('kind')
  }
  return errs
}

/** Build a VoiceAttach after native dictation finalizes. */
export function buildVoiceAttach(input: {
  requestId: string
  capability: VoiceSessionCapability
  transcript: string
  mode?: VoiceBrainLane
  micMode?: VoiceMicMode
  sttBackend?: VoiceSttBackend
  sttFinalizedAt?: string
}): VoiceAttach {
  return {
    type: 'voice.attach',
    requestId: input.requestId,
    sessionId: input.capability.sessionId,
    hostId: input.capability.hostId,
    worktreeId: input.capability.worktreeId,
    mode: input.mode ?? input.capability.defaultLane,
    transcript: input.transcript.trim(),
    sttFinalizedAt: input.sttFinalizedAt ?? new Date().toISOString(),
    micMode: input.micMode ?? 'hold-to-talk',
    sttBackend: input.sttBackend ?? 'on-device'
  }
}
