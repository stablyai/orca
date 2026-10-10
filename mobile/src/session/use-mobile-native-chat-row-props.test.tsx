import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import { useMobileNativeChatRowProps } from './use-mobile-native-chat-row-props'
import {
  useMobileNativeChatTurnDisclosure,
  type MobileNativeChatTurnRow
} from './use-mobile-native-chat-turn-disclosure'

function row(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: null, source: 'transcript' }
}

let rendered: readonly MobileNativeChatTurnRow[] = []

function Harness({
  messages,
  workedSeconds = 4
}: {
  messages: readonly NativeChatMessage[]
  workedSeconds?: number
}): null {
  // The host rebuilds this map on every batch, equal values or not.
  const settledTurns: NativeChatSettledTurns = new Map([
    ['u1', { startedAt: 1_000, workedSeconds }]
  ])
  const turns = useMobileNativeChatTurnDisclosure({
    messages,
    enabled: true,
    isWorking: true,
    settledTurns,
    scopeKey: 'host\0worktree\0tab-a'
  })
  rendered = useMobileNativeChatRowProps(turns.listMessages, turns.resolveRow)
  return null
}

describe('useMobileNativeChatRowProps', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function rows(): readonly MobileNativeChatTurnRow[] {
    return rendered
  }

  function show(messages: readonly NativeChatMessage[], workedSeconds?: number): void {
    act(() => {
      const element = createElement(Harness, { messages, workedSeconds })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  const history = [
    row('u1', 'user', 'go'),
    row('a1', 'assistant', 'done'),
    row('u2', 'user', 'next')
  ]

  it('keeps every row, and the array, while only the live reply grows', () => {
    show([...history, row('a2', 'assistant', 'Hel')])
    const before = rows()
    expect(before[0]?.turnStatus).toMatchObject({ workedSeconds: 4 })

    show([...history, row('a2', 'assistant', 'Hello')])

    expect(rows()).toBe(before)
  })

  it('keeps unchanged rows when a new row lands, and rebuilds a row whose values change', () => {
    show([...history, row('a2', 'assistant', 'Hello')])
    const before = rows()

    show([...history, row('a2', 'assistant', 'Hello'), row('u3', 'user', 'more')])
    expect(rows()).not.toBe(before)
    expect(rows()[0]).toBe(before[0])

    show([...history, row('a2', 'assistant', 'Hello'), row('u3', 'user', 'more')], 9)
    expect(rows()[0]).not.toBe(before[0])
    expect(rows()[0]?.turnStatus).toMatchObject({ workedSeconds: 9 })
  })

  it('skips resolving rows on a render that changed neither the rows nor the resolver', () => {
    const resolveTurnRow = vi.fn((): MobileNativeChatTurnRow => ({
      turnStatus: null,
      turnExpanded: false,
      activeTurnIsWorking: false
    }))
    // Stands in for the view re-rendering on a composer keystroke.
    function Static({ composerText }: { composerText: string }): string {
      rendered = useMobileNativeChatRowProps(history, resolveTurnRow)
      return composerText
    }
    act(() => {
      renderer = create(createElement(Static, { composerText: 'h' }))
    })
    const calls = resolveTurnRow.mock.calls.length
    act(() => renderer?.update(createElement(Static, { composerText: 'hi' })))

    expect(resolveTurnRow.mock.calls.length).toBe(calls)
  })
})
