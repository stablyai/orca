import './mobile-agent-message-renderer.test-fixture'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { messages, Transcript } from './mobile-native-chat-turn-diff.test-fixture'
import { MobileNativeChatTurnDiffRollup } from './MobileNativeChatTurnDiffRollup'
import type * as TurnDiffRollupModule from './MobileNativeChatTurnDiffRollup'

vi.mock('./MobileNativeChatTurnDiffRollup', async (importOriginal) => {
  const actual = await importOriginal<typeof TurnDiffRollupModule>()
  return { ...actual, MobileNativeChatTurnDiffRollup: vi.fn(actual.MobileNativeChatTurnDiffRollup) }
})

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
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
