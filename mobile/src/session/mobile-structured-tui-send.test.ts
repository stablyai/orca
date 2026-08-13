import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { resetMobileNativeChatStaleInputForTests } from './mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from './mobile-native-chat-terminal-write-lock'
import {
  getMobileStructuredTuiTerminal,
  sendMobileStructuredTuiComposerMessage,
  sendMobileStructuredTuiMessage
} from './mobile-structured-tui-send'

function acceptingClient(): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue({
      id: 'send',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })
  } as unknown as RpcClient
}

afterEach(() => {
  vi.useRealTimers()
  resetMobileNativeChatStaleInputForTests()
  resetMobileNativeChatTerminalWritesForTests()
})

describe('sendMobileStructuredTuiMessage', () => {
  it('accepts only an idle TUI handoff terminal', () => {
    expect(
      getMobileStructuredTuiTerminal({
        owner: 'tui',
        direction: null,
        phase: 'idle',
        stage: null,
        operationId: null,
        terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'pane-tui' }
      })
    ).toBe('term-tui')
    expect(
      getMobileStructuredTuiTerminal({
        owner: 'tui',
        direction: 'to-native',
        phase: 'waiting-for-exit',
        stage: 'wait-for-tui-exit',
        operationId: 'handoff-1',
        terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'pane-tui' }
      })
    ).toBeNull()
  })

  it('routes stable TUI composer text through terminal.send', async () => {
    const client = acceptingClient()

    await expect(
      sendMobileStructuredTuiMessage({
        client,
        terminal: 'term-tui',
        agent: 'codex',
        deviceToken: 'mobile-1',
        text: 'hello',
        attachments: []
      })
    ).resolves.toBe('accepted')

    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'term-tui',
        text: '\x15hello',
        enter: true,
        client: { id: 'mobile-1', type: 'mobile' }
      },
      expect.objectContaining({ budgetSpansConnect: true })
    )
  })

  it('types stable TUI slash commands one key at a time', async () => {
    vi.useFakeTimers()
    const client = acceptingClient()

    const sending = sendMobileStructuredTuiMessage({
      client,
      terminal: 'term-tui',
      agent: 'codex',
      deviceToken: null,
      text: '/model',
      attachments: []
    })
    await vi.runAllTimersAsync()
    await expect(sending).resolves.toBe('accepted')

    expect(
      vi
        .mocked(client.sendRequest)
        .mock.calls.map(([, params]) => (params as { text: string }).text)
    ).toEqual(['\x15', '/', 'm', 'o', 'd', 'e', 'l', '\r'])
    expect(
      vi
        .mocked(client.sendRequest)
        .mock.calls.every(
          ([method, params]) =>
            method === 'terminal.send' && (params as { enter: boolean }).enter === false
        )
    ).toBe(true)
  })

  it('types Claude-only slash commands through the provider command path', async () => {
    vi.useFakeTimers()
    const client = acceptingClient()

    const sending = sendMobileStructuredTuiMessage({
      client,
      terminal: 'term-claude',
      agent: 'claude',
      deviceToken: null,
      text: '/clear',
      attachments: []
    })
    await vi.runAllTimersAsync()
    await expect(sending).resolves.toBe('accepted')

    expect(
      vi
        .mocked(client.sendRequest)
        .mock.calls.map(([, params]) => (params as { text: string }).text)
    ).toEqual(['\x15', '/', 'c', 'l', 'e', 'a', 'r', '\r'])
  })

  it('settles the composer only after its proven TUI owner accepts the send', async () => {
    const onAccepted = vi.fn()

    await expect(
      sendMobileStructuredTuiComposerMessage({
        client: acceptingClient(),
        connected: true,
        agent: 'claude',
        handoff: {
          owner: 'tui',
          direction: null,
          phase: 'idle',
          stage: null,
          operationId: null,
          terminal: { handle: 'term-claude', tabId: 'tab-claude', paneKey: 'pane-claude' }
        },
        deviceToken: null,
        text: 'hello',
        attachments: [],
        onAccepted,
        onToast: vi.fn()
      })
    ).resolves.toBe(true)
    expect(onAccepted).toHaveBeenCalledOnce()
  })
})
