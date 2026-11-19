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
    act(() => {
      renderer = create(
        createElement(Harness, {
          messages: editTurn,
          enabled: true,
          isWorking: false,
          showsTurnDiffs
        })
      )
    })
    const { resolveRow }: ReturnType<typeof useMobileNativeChatTurnDisclosure> =
      renderer!.root.findByType(Result).props.disclosure
    return resolveRow(1, editTurn[1]).turnDiff?.files.map((file) => file.path)
  }

  it('shows the edited files in a normal chat', () => {
    expect(turnDiffPaths(true)).toEqual(['/repo/notes.md'])
  })

  it('shows nothing in a chat whose own edits are scratch files', () => {
    expect(turnDiffPaths(false)).toBeUndefined()
  })
})
