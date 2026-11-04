import './mobile-agent-message-renderer.test-fixture'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'
import { MobileNativeChatRowContent } from './MobileNativeChatRowItemSource'
import { findAllByHostType } from '../../../test-support/react-test-renderer-host-nodes'
import { MobileNativeChatTurnDiffRollup } from './MobileNativeChatTurnDiffRollup'

vi.mock('./MobileNativeChatTurnDiffRollup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MobileNativeChatTurnDiffRollup')>()
  return { ...actual, MobileNativeChatTurnDiffRollup: vi.fn(actual.MobileNativeChatTurnDiffRollup) }
})

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))
let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

const messages: NativeChatMessage[] = [
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
function Transcript({
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
function textIn(node: ReactTestInstance): string[] {
  return findAllByHostType(node, 'Text').map((text) => String(text.children.join('')))
}

it('shows finished-turn files outside folded work and opens a patch with one tap', () => {
  act(() => {
    renderer = create(createElement(Transcript, { working: true }))
  })
  expect(textIn(renderer!.root)).toContain('greeting.ts')
  act(() => {
    renderer!.update(createElement(Transcript))
  })
  expect(textIn(renderer!.root)).toContain('greeting.ts')
  expect(textIn(renderer!.root)).not.toContain('diagnostic-output')
  expect(textIn(renderer!.root)).not.toContain('helloNew()')
  const file = findAllByHostType(renderer!.root, 'Pressable').find(
    (node) => node.props.accessibilityLabel === '/repo/greeting.ts'
  )!
  act(() => file.props.onPress())
  expect(textIn(renderer!.root)).toContain('helloNew()')
  expect(textIn(renderer!.root)).not.toContain('statusNew()')
  act(() => renderer!.unmount())
  act(() => {
    renderer = create(createElement(Transcript))
  })
  expect(textIn(renderer!.root)).toContain('status.ts')
})

it.each([10, 100])(
  'does not repaint unrelated outcome rows while another turn streams (%i turns)',
  (count) => {
    const rows = Array.from({ length: count }, (_, index) =>
      messages.map((message) => ({
        ...message,
        id: `${index}:${message.id}`
      }))
    ).flat()
    act(() => {
      renderer = create(createElement(Transcript, { rows }))
    })
    const outcome = vi.mocked(MobileNativeChatTurnDiffRollup)
    const before = outcome.mock.calls.length
    const last = rows.at(-1)!
    const updated = [
      ...rows.slice(0, -1),
      { ...last, blocks: [{ type: 'text' as const, text: 'Updated again.' }] }
    ]
    act(() => {
      renderer!.update(createElement(Transcript, { rows: updated }))
    })
    expect(outcome.mock.calls.length - before).toBe(0)
    const changed = updated.map((message) =>
      message.id === `${count - 1}:edit`
        ? {
            ...message,
            blocks: message.blocks.map((block) =>
              block.type === 'tool-call' && block.name === 'Edit'
                ? {
                    ...block,
                    input: {
                      file_path: '/repo/greeting.ts',
                      old_string: 'helloOld()',
                      new_string: 'helloNewest()'
                    }
                  }
                : block
            )
          }
        : message
    )
    act(() => {
      renderer!.update(createElement(Transcript, { rows: changed }))
    })
    expect(outcome.mock.calls.length - before).toBe(1)
    const latest = outcome.mock.calls.at(-1)![0].diff
    expect(latest.files.map((file) => file.path)).toContain('/repo/greeting.ts')
  }
)
