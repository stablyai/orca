import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-events'
import { recordMobileChatSend, recordMobileViewOpened } from './mobile-client-telemetry'

const telemetry = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('./client', () => telemetry)

beforeEach(() => {
  telemetry.track.mockReset()
})

function isEventName(name: unknown): name is keyof typeof eventSchemas {
  return typeof name === 'string' && name in eventSchemas
}

function trackedPayloads() {
  return telemetry.track.mock.calls.map(([name, props]) => {
    if (!isEventName(name)) {
      throw new Error(`unknown event ${String(name)}`)
    }
    eventSchemas[name].parse(props)
    return [name, props]
  })
}

describe('mobile client telemetry', () => {
  it('counts a new phone send once and leaves desktop sends to the renderer', () => {
    recordMobileChatSend('mobile', 'claude', { ok: true, replayed: false })
    recordMobileChatSend('mobile', 'claude', { ok: true, replayed: true })
    recordMobileChatSend('mobile', 'claude', { ok: false })
    recordMobileChatSend('runtime', 'claude', { ok: true, replayed: false })
    recordMobileChatSend(undefined, 'claude', { ok: true, replayed: false })

    expect(trackedPayloads()).toEqual([
      [
        'native_chat_message_sent',
        { agent_kind: 'claude-code', runtime: 'unknown', client: 'mobile' }
      ]
    ])
  })

  it('records each view a phone opens once a day per surface', () => {
    const open = (
      surface: 'chat' | 'terminal',
      viewKey: string,
      agent: string | null,
      now: string,
      deviceId = 'phone-1'
    ) =>
      recordMobileViewOpened(
        { clientKind: 'mobile', pairedDeviceId: deviceId },
        {
          surface,
          viewKey,
          agent: () => agent,
          now: new Date(now)
        }
      )

    open('chat', 'agentSession:s1', 'codex', '2026-11-05T10:00:00Z')
    // A reconnect reopens the same stream.
    open('chat', 'agentSession:s1', 'codex', '2026-11-05T18:00:00Z')
    // The same terminal, read as chat on this phone and as a terminal later, counts as both.
    open('chat', 'nativeChat:claude:t1', 'claude', '2026-11-05T10:00:00Z')
    open('terminal', 'terminal:pty-1', 'claude', '2026-11-05T10:00:00Z')
    open('terminal', 'terminal:pty-2', null, '2026-11-05T10:00:00Z')
    open('chat', 'agentSession:s1', 'codex', '2026-11-05T10:00:00Z', 'phone-2')
    open('chat', 'agentSession:s1', 'codex', '2026-11-06T09:00:00Z')
    recordMobileViewOpened(
      { clientKind: 'runtime' },
      {
        surface: 'chat',
        viewKey: 'agentSession:desktop',
        agent: () => 'codex'
      }
    )

    expect(trackedPayloads()).toEqual([
      ['mobile_session_opened', { surface: 'chat', agent_kind: 'codex' }],
      ['mobile_session_opened', { surface: 'chat', agent_kind: 'claude-code' }],
      ['mobile_session_opened', { surface: 'terminal', agent_kind: 'claude-code' }],
      ['mobile_session_opened', { surface: 'terminal' }],
      ['mobile_session_opened', { surface: 'chat', agent_kind: 'codex' }],
      ['mobile_session_opened', { surface: 'chat', agent_kind: 'codex' }]
    ])
  })
})
