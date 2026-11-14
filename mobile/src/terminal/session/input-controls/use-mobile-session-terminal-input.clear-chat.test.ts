import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { mountFixture } from '../../../test-support/rpc-recording/recorder-fixture-shape'
import { storedTabChatTranscriptIdentity } from '../../../session/native-chat/transcript/mobile-native-chat-transcript-store'
import { useMobileNativeChatDisplayMessages } from '../../../session/native-chat/transcript/mobile-native-chat-display-clear'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'

it('clears a chat display only after the terminal buffer clear succeeds, without sending agent input', async () => {
  const tab = {
    id: 'tab',
    type: 'terminal' as const,
    terminal: 'terminal',
    nativeChatIdentity: {
      terminal: 'terminal',
      agent: 'codex',
      sessionId: 'session',
      transcriptPath: null
    }
  }
  const row: NativeChatMessage = {
    id: 'old',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'retained in transcript' }],
    timestamp: 1000,
    source: 'transcript',
    transcriptOrder: 10
  }
  const rows = [row]
  const identity = storedTabChatTranscriptIdentity('host', 'workspace', tab, true)!
  let cleared = false
  const client = mountFixture<RpcClient>({
    sendRequest: async (method) => {
      if (method === 'nativeChat.readSession') {
        return { id: 'request', ok: true, result: { messages: rows, hasMore: false } }
      }
      if (method === 'terminal.clearBuffer') {
        return { id: 'request', ok: true, result: { clear: { cleared } } }
      }
      throw new Error(`Unexpected agent or terminal operation: ${method}`)
    }
  })
  const scope = mountFixture<Parameters<typeof useMobileSessionTerminalInput>[0]>({
    client,
    clientRef: { current: client },
    hostId: 'host',
    worktreeId: 'workspace',
    sessionTabsRef: { current: [tab] },
    nativeChatTranscriptIsLocalReadable: true,
    nativeChatController: { isTabChatView: () => true },
    terminalUnsubsRef: { current: new Map() },
    showToast: () => {}
  })
  let shown: string[] = []
  let input: ReturnType<typeof useMobileSessionTerminalInput> | null = null
  function Harness(): null {
    input = useMobileSessionTerminalInput(scope)
    shown = useMobileNativeChatDisplayMessages(identity, rows).messages.map((message) => message.id)
    return null
  }
  let renderer: ReactTestRenderer | null = null
  const target = { handle: 'terminal', title: 'Codex', isActive: true }
  try {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(shown).toEqual(['old'])
    await act(async () => {
      await input?.handleClearTerminal(target)
    })
    expect(shown).toEqual(['old'])
    cleared = true
    await act(async () => {
      await input?.handleClearTerminal(target)
    })
    expect(shown).toEqual([])
    expect(row.blocks).toEqual([{ type: 'text', text: 'retained in transcript' }])
  } finally {
    await act(async () => {
      renderer?.unmount()
    })
  }
})
