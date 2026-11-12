import { expect, it } from 'vitest'
import type { AgentSessionVoiceEvent } from '../../../../shared/agent-session/agent-session-voice-conversation'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { CodexRealtimeVoice } from './codex-realtime-voice'

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await Promise.resolve()
  }
}

function fakeConnection(timeline: () => Promise<unknown> = async () => ({ data: [] })) {
  const requests: { method: string; params: Record<string, unknown> | undefined }[] = []
  let closed = false
  const connection = {
    pid: 1,
    get closed() {
      return closed
    },
    request: async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params })
      if (method === 'thread/realtime/listVoices') {
        // codex-cli 0.165.0's answer, trimmed: `marin` is a v2 voice that v3 lacks.
        return {
          voices: {
            v1: ['cove', 'marin'],
            v2: ['marin', 'cedar'],
            v3: ['juniper', 'cove', 'maple'],
            defaultV1: 'cove',
            defaultV2: 'marin'
          }
        }
      }
      return method === 'thread/timeline/list' ? timeline() : {}
    },
    notify: () => {},
    respond: () => {},
    respondWithError: () => {},
    close: async () => true
  } satisfies CodexAppServerConnection
  const methods = () => requests.map((request) => request.method)
  const exit = () => {
    closed = true
  }
  return { connection, requests, methods, exit }
}

function attempt(
  voice: CodexRealtimeVoice,
  connection: CodexAppServerConnection,
  preferred?: string
) {
  const events: AgentSessionVoiceEvent[] = []
  const handle = voice.start(
    { threadId: 'thread-1', connection, ended: false },
    {
      sessionId: 'session-1',
      offerSdp: 'v=0 offer',
      ...(preferred ? { voice: preferred } : {}),
      emit: (event) => events.push(event)
    }
  )
  return { events, handle }
}

it('fences a stopped attempt until its own requested close, then serves the next attempt', async () => {
  const voice = new CodexRealtimeVoice()
  const { connection, requests, methods } = fakeConnection()
  const notify = (method: string, params: Record<string, unknown>) =>
    voice.observe('session-1', connection, method, { threadId: 'thread-1', ...params })

  const first = attempt(voice, connection)
  await settle()
  expect(requests.find((request) => request.method === 'thread/realtime/start')?.params).toEqual({
    threadId: 'thread-1',
    outputModality: 'audio',
    transport: { type: 'webrtc', sdp: 'v=0 offer' },
    version: 'v3',
    clientManagedHandoffs: false,
    includeStartupContext: false,
    flushTranscriptTailOnSessionEnd: false,
    backendReasoningStatus: false
  })
  first.handle.stop()
  expect(first.events).toEqual([{ type: 'ended', reason: 'requested' }])
  expect(methods().at(-1)).toBe('thread/realtime/stop')

  // Frames the core emitted for the first attempt before its stop reach nobody.
  notify('thread/realtime/sdp', { sdp: 'v=0 late answer' })
  notify('thread/realtime/error', { message: 'late failure' })
  notify('thread/realtime/closed', { reason: 'transport_closed' })
  const blocked = attempt(voice, connection)
  expect(blocked.events).toEqual([{ type: 'refused', reason: 'busy' }])
  expect(first.events).toHaveLength(1)

  notify('thread/realtime/closed', { reason: 'requested' })
  const second = attempt(voice, connection)
  await settle()
  notify('thread/realtime/sdp', { sdp: 'v=0 answer' })
  expect(second.events).toEqual([{ type: 'answer', sdp: 'v=0 answer' }])
  expect(first.events).toHaveLength(1)
})

it('never starts Codex voice when the user stops while the chat history is read', async () => {
  let readHistory: (page: unknown) => void = () => {}
  const voice = new CodexRealtimeVoice()
  const { connection, methods } = fakeConnection(
    () => new Promise((resolve) => (readHistory = resolve))
  )
  const call = attempt(voice, connection)
  await settle()
  call.handle.stop()
  readHistory({ data: [] })
  await settle()
  expect(methods()).toEqual(['thread/timeline/list', 'thread/realtime/stop'])
  expect(call.events).toEqual([{ type: 'ended', reason: 'requested' }])
})

it('ends the call when its own app-server child ends, not when an older child does', () => {
  const voice = new CodexRealtimeVoice()
  const { connection, exit } = fakeConnection()
  const forwarded: unknown[] = []
  const deps = voice.endWithChildren(
    { resolveLaunch: () => Promise.reject(new Error('unused')), onEvent: (e) => forwarded.push(e) },
    () => connection
  )
  const call = attempt(voice, connection)

  deps.onEvent?.({ type: 'ended', sessionId: 'session-1', reason: 'older child exited' })
  expect(call.events).toEqual([])

  exit()
  deps.onEvent?.({ type: 'ended', sessionId: 'session-1', reason: 'exit' })
  expect(call.events).toEqual([{ type: 'ended', reason: 'provider-exited' }])
  expect(forwarded).toHaveLength(2)
})

it('starts with the preferred voice only when this Codex lists it for v3', async () => {
  const voice = new CodexRealtimeVoice()
  const { connection, requests } = fakeConnection()
  const startParams = () =>
    requests.findLast((request) => request.method === 'thread/realtime/start')?.params
  const notify = (method: string, params: Record<string, unknown>) =>
    voice.observe('session-1', connection, method, { threadId: 'thread-1', ...params })

  const listed = attempt(voice, connection, 'juniper')
  await settle()
  expect(startParams()?.voice).toBe('juniper')
  expect(listed.events).toEqual([])
  listed.handle.stop()
  notify('thread/realtime/closed', { reason: 'requested' })

  const unlisted = attempt(voice, connection, 'marin')
  await settle()
  expect(startParams()).not.toHaveProperty('voice')
  expect(unlisted.events).toEqual([{ type: 'voice-unavailable', voice: 'marin' }])
  expect(await voice.listVoices({ connection, ended: false })).toEqual(['juniper', 'cove', 'maple'])
})
