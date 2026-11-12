import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatTranscriptSettledTurns } from '../../../../../src/shared/native-chat/native-chat-terminal-turn'

import { Harness, Result } from './use-mobile-native-chat-turn-disclosure.test-fixture'

// A chat without turn records groups rows by the preceding user message, so a turn a background
// subagent's hand-back started (no new user row) shares the previous turn's key. The fold must
// still keep each provider turn's reply visible there (#41556).
describe('useMobileNativeChatTurnDisclosure without a turn journal', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('keeps the earlier reply visible when a hand-back reply follows without a new user message', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(60_000)
      const message = (
        id: string,
        role: 'user' | 'assistant',
        timestamp: number
      ): NativeChatMessage => ({
        id,
        role,
        blocks: [{ type: 'text', text: id }],
        timestamp,
        source: 'transcript'
      })
      const messages = [
        message('u1', 'user', 10_000),
        message('reply-a', 'assistant', 20_000),
        message('reply-b', 'assistant', 40_000),
        message('u2', 'user', 50_000),
        message('reply-c', 'assistant', 55_000)
      ]
      const settledTurns = nativeChatTranscriptSettledTurns(messages)
      act(() => {
        renderer = create(
          createElement(Harness, {
            messages,
            enabled: true,
            isWorking: false,
            settledTurns,
            scopeKey: 'host\0worktree\0tab-a'
          })
        )
      })
      const disclosure = renderer!.root.findByType(Result).props.disclosure
      const folded: string[] = disclosure.listMessages
        .map((entry: NativeChatMessage, index: number) => ({
          id: entry.id,
          foldedAway: disclosure.resolveRow(index, entry).foldedAway === true
        }))
        .filter((row: { id: string; foldedAway: boolean }) => row.foldedAway)
        .map((row: { id: string }) => row.id)
      expect(folded).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
