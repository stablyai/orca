import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { SubscribeNativeChatTranscriptArgs } from '../../native-chat/transcript-watch'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }))

vi.mock('../../native-chat/transcript-watch', () => ({
  subscribeNativeChatTranscript: mocks.subscribe
}))

import { subscribeRoomHarnessTranscript } from './harness-transcript-subscription'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.subscribe.mockResolvedValue({ watching: true, unsubscribe: vi.fn() })
})

describe('subscribeRoomHarnessTranscript', () => {
  it('confirms a PTY user-only append without adding the root prompt to activity', async () => {
    const onEvent = vi.fn()
    await subscribeRoomHarnessTranscript(
      'claude',
      {
        worktreeId: 'worktree-1',
        terminalHandle: 'terminal-1',
        paneKey: 'tab:claude',
        providerSession: { key: 'session_id', id: 'session-1' }
      },
      { onSnapshot: vi.fn(), onEvent, onOpaqueAppend: vi.fn() }
    )
    const subscription = mocks.subscribe.mock.calls[0]![0] as SubscribeNativeChatTranscriptArgs
    const root: NativeChatMessage = {
      id: 'prompt-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Room prompt' }],
      timestamp: 1,
      source: 'transcript'
    }

    subscription.onAppend([root])

    expect(onEvent).toHaveBeenCalledWith({
      type: 'activity',
      source: 'transcript',
      turnId: null,
      timestamp: 1,
      messages: [],
      userMessage: { id: 'prompt-1', text: 'Room prompt' },
      activity: { kind: 'thinking' }
    })
  })

  it('keeps assistant activity when harness noise follows the root prompt', async () => {
    const onEvent = vi.fn()
    await subscribeRoomHarnessTranscript(
      'claude',
      {
        worktreeId: 'worktree-1',
        terminalHandle: 'terminal-1',
        paneKey: 'tab:claude',
        providerSession: { key: 'session_id', id: 'session-1' }
      },
      { onSnapshot: vi.fn(), onEvent, onOpaqueAppend: vi.fn() }
    )
    const subscription = mocks.subscribe.mock.calls[0]![0] as SubscribeNativeChatTranscriptArgs
    const messages: NativeChatMessage[] = [
      {
        id: 'prompt-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Room prompt' }],
        timestamp: 1,
        source: 'transcript'
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Checking' }],
        timestamp: 2,
        source: 'transcript'
      },
      {
        id: 'noise-1',
        role: 'user',
        blocks: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }],
        timestamp: 3,
        source: 'transcript'
      }
    ]

    subscription.onAppend(messages)

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'activity',
        userMessage: { id: 'prompt-1', text: 'Room prompt' },
        messages: [messages[1]]
      })
    )
  })

  it('does not carry tool activity from a previous turn in the same append', async () => {
    const onEvent = vi.fn()
    await subscribeRoomHarnessTranscript(
      'claude',
      {
        worktreeId: 'worktree-1',
        terminalHandle: 'terminal-1',
        paneKey: 'tab:claude',
        providerSession: { key: 'session_id', id: 'session-1' }
      },
      { onSnapshot: vi.fn(), onEvent, onOpaqueAppend: vi.fn() }
    )
    const subscription = mocks.subscribe.mock.calls[0]![0] as SubscribeNativeChatTranscriptArgs
    const messages: NativeChatMessage[] = [
      {
        id: 'old-prompt',
        role: 'user',
        blocks: [{ type: 'text', text: 'Old prompt' }],
        timestamp: 1,
        source: 'transcript'
      },
      {
        id: 'old-tool',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'sleep 10' } }],
        timestamp: 2,
        source: 'transcript'
      },
      {
        id: 'current-prompt',
        role: 'user',
        blocks: [{ type: 'text', text: 'Current prompt' }],
        timestamp: 3,
        source: 'transcript'
      }
    ]

    subscription.onAppend(messages)

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: { id: 'current-prompt', text: 'Current prompt' },
        messages: [],
        activity: { kind: 'thinking' }
      })
    )
  })
})
