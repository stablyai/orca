import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-events'
import type { RuntimeMobileSessionSnapshotTab } from '../../shared/runtime-mobile-session-tab-contracts'
import { recordMobileChatSend, recordMobileSessionOpened } from './mobile-client-telemetry'

const telemetry = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('./client', () => telemetry)

beforeEach(() => {
  telemetry.track.mockReset()
})

function trackedPayloads() {
  return telemetry.track.mock.calls.map(([name, props]) => {
    eventSchemas[name as keyof typeof eventSchemas].parse(props)
    return [name, props]
  })
}

const chatTab = {
  type: 'agent-session',
  id: 'tab-chat',
  title: 'Chat',
  sessionId: 's1',
  agent: 'codex',
  isActive: true
} as RuntimeMobileSessionSnapshotTab

const shellTab = {
  type: 'terminal',
  id: 'tab-term',
  title: 'zsh',
  parentTabId: 'p1',
  leafId: 'l1',
  ptyId: 'pty-1',
  viewMode: 'terminal',
  isActive: true
} as RuntimeMobileSessionSnapshotTab

describe('mobile client telemetry', () => {
  it('counts an accepted phone send and leaves desktop sends to the renderer', () => {
    recordMobileChatSend('mobile', 'claude', { ok: true })
    recordMobileChatSend('mobile', 'claude', { ok: false })
    recordMobileChatSend('runtime', 'claude', { ok: true })
    recordMobileChatSend(undefined, 'claude', { ok: true })

    expect(trackedPayloads()).toEqual([
      [
        'native_chat_message_sent',
        { agent_kind: 'claude-code', runtime: 'local', client: 'mobile' }
      ]
    ])
  })

  it('records each phone tab once a day, with typed agents and plain shells told apart', () => {
    const open = (tab: RuntimeMobileSessionSnapshotTab, now: string, paneAgent: string | null) =>
      recordMobileSessionOpened({
        clientKind: 'mobile',
        deviceId: 'phone-1',
        worktree: 'wt-1',
        tab,
        paneAgent: () => paneAgent,
        now: new Date(now)
      })

    open(chatTab, '2026-11-05T10:00:00Z', null)
    open(chatTab, '2026-11-05T18:00:00Z', null)
    open(shellTab, '2026-11-05T10:00:00Z', 'claude')
    open({ ...shellTab, id: 'tab-shell' }, '2026-11-05T10:00:00Z', null)
    open(chatTab, '2026-11-06T09:00:00Z', null)
    recordMobileSessionOpened({
      clientKind: 'runtime',
      deviceId: undefined,
      worktree: 'wt-1',
      tab: { ...chatTab, id: 'desktop-tab' },
      paneAgent: () => null
    })

    expect(trackedPayloads()).toEqual([
      ['mobile_session_opened', { surface: 'chat', agent_kind: 'codex' }],
      ['mobile_session_opened', { surface: 'terminal', agent_kind: 'claude-code' }],
      ['mobile_session_opened', { surface: 'terminal' }],
      ['mobile_session_opened', { surface: 'chat', agent_kind: 'codex' }]
    ])
  })
})
