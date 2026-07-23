import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_SESSION_SETTINGS,
  buildVoiceAttach,
  validateVoiceAttach,
  validateVoiceSessionCapability,
  type VoiceAttach,
  type VoiceSessionCapability
} from './session-voice-contract'

const sampleCap: VoiceSessionCapability = {
  sessionId: 'wt-abc',
  hostId: 'node-b',
  worktreeId: 'wt-abc',
  label: 'Herm TUI · meshina',
  acceptsInject: true,
  acceptsTtsBack: true,
  defaultLane: 'agent',
  kind: 'orca-mother-session'
}

describe('M0 session-voice-contract', () => {
  it('defaults match operator locks (spoken confirm, mesh TTS, on-device STT)', () => {
    expect(DEFAULT_VOICE_SESSION_SETTINGS.spokenConfirmTools).toBe(true)
    expect(DEFAULT_VOICE_SESSION_SETTINGS.sttBackend).toBe('on-device')
    expect(DEFAULT_VOICE_SESSION_SETTINGS.ttsBackend).toBe('mesh')
    expect(DEFAULT_VOICE_SESSION_SETTINGS.micMode).toBe('hold-to-talk')
  })

  it('validates a mother-session capability', () => {
    expect(validateVoiceSessionCapability(sampleCap)).toEqual([])
  })

  it('buildVoiceAttach produces a valid inject payload (text wire)', () => {
    const msg = buildVoiceAttach({
      requestId: 'req-1',
      capability: sampleCap,
      transcript: '  restart the collab board  '
    })
    expect(msg.type).toBe('voice.attach')
    expect(msg.transcript).toBe('restart the collab board')
    expect(msg.mode).toBe('agent')
    expect(msg.sttBackend).toBe('on-device')
    expect(validateVoiceAttach(msg)).toEqual([])
  })

  it('rejects empty transcript', () => {
    const bad: VoiceAttach = {
      type: 'voice.attach',
      requestId: 'r',
      sessionId: 's',
      hostId: 'h',
      mode: 'fast',
      transcript: '   ',
      sttFinalizedAt: new Date().toISOString(),
      micMode: 'toggle',
      sttBackend: 'on-device'
    }
    expect(validateVoiceAttach(bad)).toContain('transcript')
  })
})
