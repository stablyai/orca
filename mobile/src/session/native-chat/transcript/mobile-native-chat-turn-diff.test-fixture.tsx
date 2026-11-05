import './mobile-agent-message-renderer.test-fixture'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { ReactTestInstance } from 'react-test-renderer'
import { vi } from 'vitest'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'
import { MobileNativeChatRowContent } from './MobileNativeChatRowItemSource'
import { findAllByHostType } from '../../../test-support/react-test-renderer-host-nodes'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

export const messages: NativeChatMessage[] = [
  {
    id: 'u',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'Fix the greeting' }]
  },
  {
    id: 'edit',
    role: 'assistant',
    source: 'transcript',
    timestamp: 2,
    blocks: [
      {
        type: 'tool-call',
        name: 'Bash',
        state: 'completed',
        input: { command: 'inspect-diagnostic' }
      },
      { type: 'tool-result', output: 'diagnostic-output' },
      {
        type: 'tool-call',
        name: 'Edit',
        state: 'completed',
        input: {
          file_path: '/repo/greeting.ts',
          old_string: 'helloOld()',
          new_string: 'helloNew()'
        }
      },
      { type: 'tool-result', output: 'The file /repo/greeting.ts has been updated successfully.' },
      { type: 'tool-call', name: 'Diff', input: { path: 'status.ts' } },
      { type: 'tool-result', output: '@@ -1 +1 @@\n-statusOld()\n+statusNew()' }
    ]
  },
  {
    id: 'answer',
    role: 'assistant',
    source: 'transcript',
    timestamp: 3,
    blocks: [{ type: 'text', text: 'Updated the greeting.' }]
  }
]
const settled = new Map([['u', { startedAt: 1, workedSeconds: 2 }]])
export function Transcript({
  rows = messages,
  working = false
}: {
  rows?: NativeChatMessage[]
  working?: boolean
}) {
  const turns = useMobileNativeChatTurnDisclosure({
    messages: rows,
    enabled: true,
    isWorking: working,
    settledTurns: working ? undefined : settled,
    scopeKey: 'test'
  })
  return (
    <>
      {turns.listMessages.map((message, index) => (
        <MobileNativeChatRowContent
          key={message.id}
          {...turns.resolveRow(index, message)}
          message={message}
          structuredActivityUi
          source={null}
          scope="test"
          onToggleTurn={turns.onToggleTurn}
        />
      ))}
    </>
  )
}
export function textIn(node: ReactTestInstance): string[] {
  return findAllByHostType(node, 'Text').map((text) => String(text.children.join('')))
}
