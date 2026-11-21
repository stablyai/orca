import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'
import type { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

const editTurn: NativeChatMessage[] = [
  userMessage('u1'),
  {
    id: 'a1',
    role: 'assistant',
    blocks: [
      {
        type: 'tool-call',
        name: 'Edit',
        input: { file_path: '/repo/notes.md', old_string: 'old', new_string: 'new' }
      },
      { type: 'tool-result', output: 'ok' },
      { type: 'text', text: 'Done.' }
    ],
    timestamp: null,
    source: 'transcript'
  }
]

describe('the turn changed-files card on the phone', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function turnDiffPaths(showsTurnDiffs: boolean) {
    const view = createElement(Harness, {
      messages: editTurn,
      enabled: true,
      isWorking: false,
      showsTurnDiffs
    })
    act(() => {
      if (renderer) {
        renderer.update(view)
      } else {
        renderer = create(view)
      }
    })
    const { resolveRow }: ReturnType<typeof useMobileNativeChatTurnDisclosure> =
      renderer!.root.findByType(Result).props.disclosure
    return resolveRow(1, editTurn[1]).turnDiff?.files.map((file) => file.path)
  }

  it('clears the changed files when the chat switches to hiding them', () => {
    expect(turnDiffPaths(true)).toEqual(['/repo/notes.md'])
    expect(turnDiffPaths(false)).toBeUndefined()
  })
})
