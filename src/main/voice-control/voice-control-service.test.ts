import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import type {
  VoiceControlSettings,
  VoiceControlStateChangedEvent,
  VoiceControlToolActivityEvent
} from '../../shared/voice-control-types'
import type { SidebandEventHandler } from './realtime-sideband-socket'
import type { VoiceControlSessionBackend } from './voice-control-session-backend'
import { VoiceControlService, type VoiceControlServiceDeps } from './voice-control-service'
import type { VoiceTranscriptEntry } from './voice-control-transcript-log'

const SETTINGS: VoiceControlSettings = {
  enabled: true,
  coordinatorVoice: 'marin',
  agentVoiceMode: 'per-agent',
  maxSessionMinutes: 0,
  customInstructions: ''
}

function emptyRoster(): RuntimeWorktreePsSummary[] {
  return []
}

function mintResponse(): Response {
  return new Response(JSON.stringify({ value: 'ek_test', expires_at: 123 }), { status: 200 })
}

function sdpResponse(callId: string): Response {
  return new Response('v=0 answer-sdp', {
    status: 201,
    headers: { Location: `https://api.openai.com/v1/realtime/calls/${callId}` }
  })
}

function fakeSidebandFactory() {
  const sentEvents: Record<string, unknown>[] = []
  const state: { closed: boolean; handler: SidebandEventHandler | null; callId: string } = {
    closed: false,
    handler: null,
    callId: ''
  }
  const create = (_apiKey: string, callId: string, handler: SidebandEventHandler) => {
    state.handler = handler
    state.callId = callId
    return {
      connect: () => Promise.resolve(),
      close: () => {
        state.closed = true
      },
      send: (event: Record<string, unknown>) => {
        sentEvents.push(event)
      }
    }
  }
  return { create, sentEvents, state }
}

function fakeBackendFactory() {
  const state: {
    started: boolean
    disposed: boolean
    toolCalls: { name: string; args: string; callId: string }[]
    observed: Record<string, unknown>[]
  } = {
    started: false,
    disposed: false,
    toolCalls: [],
    observed: []
  }
  const create: VoiceControlServiceDeps['createBackend'] = () => {
    const backend: VoiceControlSessionBackend = {
      start: () => {
        state.started = true
      },
      dispatchToolCall: (name, args, callId) => {
        state.toolCalls.push({ name, args, callId })
        return Promise.resolve()
      },
      observeEvent: (event) => {
        state.observed.push(event)
      },
      dispose: () => {
        state.disposed = true
      }
    }
    return backend
  }
  return { create, state }
}

function createHarness(overrides: Partial<VoiceControlServiceDeps> = {}) {
  const states: VoiceControlStateChangedEvent[] = []
  const toolActivity: VoiceControlToolActivityEvent[] = []
  const sideband = fakeSidebandFactory()
  const backend = fakeBackendFactory()
  const mintBodies: Record<string, unknown>[] = []
  const deps: VoiceControlServiceDeps = {
    http: {
      fetch: (url: string, init?: { body?: unknown }) => {
        if (url.includes('client_secrets')) {
          if (typeof init?.body === 'string') {
            mintBodies.push(JSON.parse(init.body))
          }
          return Promise.resolve(mintResponse())
        }
        return Promise.resolve(sdpResponse('call_1'))
      }
    },
    hasApiKey: () => true,
    readApiKey: () => 'sk-real',
    getRoster: () => Promise.resolve(emptyRoster()),
    getSettings: () => SETTINGS,
    emitState: (event) => states.push(event),
    emitToolActivity: (event) => toolActivity.push(event),
    emitAgentActivity: () => {},
    cliCommand: 'orca',
    recordTranscript: () => {},
    readRecentTranscript: () => [],
    createBackend: backend.create,
    createSideband: sideband.create,
    ...overrides
  }
  return {
    service: new VoiceControlService(deps),
    states,
    toolActivity,
    sideband,
    backend,
    mintBodies
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('VoiceControlService', () => {
  it('refuses to start without an API key', async () => {
    const { service, states } = createHarness({ hasApiKey: () => false })
    const failure = await service.start('s1')
    expect(failure?.kind).toBe('key-missing')
    expect(service.getState().state).toBe('idle')
    expect(states).toHaveLength(0)
  })

  it('classifies an undecryptable stored key instead of surfacing unknown', async () => {
    // The blob can exist but be sealed under another app identity (dev vs prod).
    const { service, states } = createHarness({
      readApiKey: () => {
        throw new Error('OpenAI API key could not be decrypted')
      }
    })
    const failure = await service.start('s1')
    expect(failure?.kind).toBe('key-unreadable')
    expect(service.getState().state).toBe('idle')
    expect(states).toHaveLength(0)
  })

  it('walks idle → minting → awaiting-sdp on start', async () => {
    const { service, states, toolActivity } = createHarness()
    expect(await service.start('s1')).toBeNull()
    expect(states.map((s) => s.state)).toEqual(['minting', 'awaiting-sdp'])
    expect(toolActivity.some((t) => t.tool === 'roster')).toBe(true)
  })

  it('rejects a second start while active', async () => {
    const { service } = createHarness()
    await service.start('s1')
    const failure = await service.start('s2')
    expect(failure?.error).toBe('voice_control_already_active')
  })

  it('classifies a mint HTTP failure and lands in error state', async () => {
    const { service, states } = createHarness({
      http: { fetch: () => Promise.resolve(new Response('nope', { status: 401 })) }
    })
    const failure = await service.start('s1')
    expect(failure?.kind).toBe('auth')
    expect(states.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
  })

  it('exchanges SDP, opens the sideband with the Location call id, and goes live', async () => {
    const { service, states, sideband } = createHarness()
    await service.start('s1')
    const result = await service.exchangeSdp('s1', 'v=0 offer')
    expect(result).toEqual({ answerSdp: 'v=0 answer-sdp' })
    expect(sideband.state.callId).toBe('call_1')
    expect(states.map((s) => s.state)).toEqual(['minting', 'awaiting-sdp', 'live'])
  })

  it('rejects an SDP exchange for the wrong session', async () => {
    const { service } = createHarness()
    await service.start('s1')
    const result = await service.exchangeSdp('somebody-else', 'v=0 offer')
    expect(result).toMatchObject({ error: 'voice_control_no_pending_session' })
  })

  it('routes tool calls to the backend with name, arguments, and call id', async () => {
    const { service, sideband, backend } = createHarness()
    await service.start('s1')
    await service.exchangeSdp('s1', 'v=0 offer')
    expect(backend.state.started).toBe(true)
    sideband.state.handler?.onEvent({
      type: 'response.function_call_arguments.done',
      name: 'list_agents',
      call_id: 'c1',
      arguments: '{}'
    })
    await flushMicrotasks()
    expect(backend.state.toolCalls).toEqual([{ name: 'list_agents', args: '{}', callId: 'c1' }])
  })

  // Live failure this guards: the coordinator needed a pasted OAuth code and told the
  // user "paste it right here in chat" — but a voice session had no text input at all.
  it('sendUserText injects the typed line as a user message and asks for a response', async () => {
    const transcript: VoiceTranscriptEntry[] = []
    const { service, sideband } = createHarness({
      recordTranscript: (entry) => transcript.push(entry)
    })
    await service.start('s1')
    await service.exchangeSdp('s1', 'v=0 offer')
    expect(service.sendUserText('s1', 'the code is abc-123')).toBe(true)
    expect(sideband.sentEvents).toContainEqual({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'the code is abc-123' }]
      }
    })
    expect(sideband.sentEvents.some((e) => e.type === 'response.create')).toBe(true)
    // The typed line lands on the same transcript feed as speech.
    expect(transcript.some((e) => e.kind === 'user' && e.text === 'the code is abc-123')).toBe(true)
  })

  it('sendUserText refuses when there is no live session or the id is not ours', async () => {
    const { service, sideband } = createHarness()
    expect(service.sendUserText('s1', 'hello')).toBe(false)
    await service.start('s1')
    // Minted but not live yet — no conversation to append to.
    expect(service.sendUserText('s1', 'hello')).toBe(false)
    expect(sideband.sentEvents).toHaveLength(0)
  })

  // Live failure this guards: an English session's "You:" lines came out as Turkish and
  // Arabic — the transcription model free-runs its language guess on noise unless pinned.
  it('pins the input transcription language to the session language (English)', async () => {
    const { service, mintBodies } = createHarness()
    await service.start('s1')
    expect(mintBodies[0]).toMatchObject({
      session: {
        audio: { input: { transcription: { model: 'gpt-4o-transcribe', language: 'en' } } }
      }
    })
  })

  it('bakes the recent transcript into the session instructions as the coordinator memory', async () => {
    const { service, mintBodies } = createHarness({
      readRecentTranscript: () => [
        { ts: Date.UTC(2026, 9, 7, 15, 12), kind: 'user', text: 'clone workato/otto' },
        {
          ts: Date.UTC(2026, 9, 7, 15, 13),
          kind: 'command',
          command: 'git clone https://github.com/workato/otto.git',
          cwd: '/Users/x',
          output: 'exit code: 0'
        },
        { ts: Date.UTC(2026, 9, 7, 15, 14), kind: 'ui', summary: 'Clicked "Assigned to me".' }
      ]
    })
    await service.start('s1')
    const session =
      typeof mintBodies[0]?.session === 'object' && mintBodies[0].session !== null
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: object-checked test read of the mint body this test harness serialized.
          (mintBodies[0].session as Record<string, unknown>)
        : null
    const instructions = String(session?.instructions)
    expect(instructions).toContain('Earlier voice sessions')
    expect(instructions).toContain('clone workato/otto')
    expect(instructions).toContain('git clone https://github.com/workato/otto.git')
    expect(instructions).toContain('screen action: Clicked "Assigned to me".')
  })

  it('records user and assistant transcripts from the sideband into the durable log', async () => {
    const transcript: VoiceTranscriptEntry[] = []
    const { service, sideband } = createHarness({
      recordTranscript: (entry) => transcript.push(entry)
    })
    await service.start('s1')
    await service.exchangeSdp('s1', 'v=0 offer')
    sideband.state.handler?.onEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'clone the repo'
    })
    sideband.state.handler?.onEvent({
      type: 'response.output_audio_transcript.done',
      transcript: 'on it'
    })
    await flushMicrotasks()
    expect(transcript).toEqual([
      expect.objectContaining({ kind: 'user', text: 'clone the repo' }),
      expect.objectContaining({ kind: 'assistant', text: 'on it' })
    ])
  })

  it('forwards every sideband event to the backend for observation', async () => {
    const { service, sideband, backend } = createHarness()
    await service.start('s1')
    await service.exchangeSdp('s1', 'v=0 offer')
    const event = { type: 'response.done', response: { id: 'r1' } }
    sideband.state.handler?.onEvent(event)
    await flushMicrotasks()
    expect(backend.state.observed).toContainEqual(event)
  })

  it('surfaces a malformed tool-call frame without killing the session', async () => {
    const { service, sideband, toolActivity } = createHarness()
    await service.start('s1')
    await service.exchangeSdp('s1', 'v=0 offer')
    sideband.state.handler?.onEvent({
      type: 'response.function_call_arguments.done',
      call_id: 'c9'
    })
    await flushMicrotasks()
    expect(toolActivity.some((t) => t.detail?.includes('malformed tool call'))).toBe(true)
    expect(service.getState().state).toBe('live')
  })

  it('moves to error state when the sideband ends mid-session', async () => {
    const { service, sideband, states } = createHarness()
    await service.start('s1')
    await service.exchangeSdp('s1', 'v=0 offer')
    sideband.state.handler?.onEnded('liveness', 'pong timeout')
    await flushMicrotasks()
    expect(states.at(-1)).toMatchObject({ state: 'error', errorKind: 'network' })
  })

  it('stops cleanly: disposes the backend, closes the sideband, and returns to idle', async () => {
    const { service, sideband, states, backend } = createHarness()
    await service.start('s1')
    await service.exchangeSdp('s1', 'v=0 offer')
    await service.stop()
    expect(backend.state.disposed).toBe(true)
    expect(sideband.state.closed).toBe(true)
    expect(states.map((s) => s.state)).toEqual([
      'minting',
      'awaiting-sdp',
      'live',
      'stopping',
      'idle'
    ])
    expect(service.getState()).toEqual({ state: 'idle', sessionId: null })
  })

  it('disposes the backend when the session fails', async () => {
    const { service, sideband, backend } = createHarness()
    await service.start('s1')
    await service.exchangeSdp('s1', 'v=0 offer')
    sideband.state.handler?.onEnded('liveness', 'pong timeout')
    await flushMicrotasks()
    expect(backend.state.disposed).toBe(true)
  })
})
