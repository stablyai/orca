import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

function said(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: null, source: 'transcript' }
}

describe('a turn a hidden card answer opened, on the phone', () => {
  it('draws nothing when the bot ended it with only the quiet marker', () => {
    const cardAnswer: NativeChatMessage = {
      ...said('c1', 'user', 'Card google-setup/step answered: done, client'),
      orcaNotice: 'card-answer'
    }
    const settled = { startedAt: 0, workedSeconds: 7 }
    const mounted: ReturnType<typeof create>[] = []
    act(() => {
      mounted.push(
        create(
          createElement(Harness, {
            messages: [
              userMessage('u1'),
              said('a1', 'assistant', 'Press Sign in to Google.'),
              cardAnswer,
              said('a2', 'assistant', 'NO_REPLY')
            ],
            enabled: true,
            isWorking: false,
            settledTurns: new Map([
              ['u1', settled],
              ['c1', settled]
            ])
          })
        )
      )
    })
    const renderer = mounted[0]!
    const { listMessages } = renderer.root.findByType(Result).props.disclosure
    expect(listMessages.map((row: NativeChatMessage) => row.id)).toEqual(['u1', 'a1'])
    act(() => renderer.unmount())
  })
})
