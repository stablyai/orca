import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

function userMessage(id: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript'
  }
}

function Harness({
  messages,
  enabled,
  isWorking = true,
  scopeKey = 'host\0worktree\0tab-a'
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  isWorking?: boolean
  scopeKey?: string
}): React.JSX.Element {
  const disclosure = useMobileNativeChatTurnDisclosure({
    messages,
    enabled,
    isWorking,
    scopeKey
  })
  return createElement('result', { disclosure })
}

describe('useMobileNativeChatTurnDisclosure', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('does not scan bridge-lane transcripts', () => {
    const messages: NativeChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }],
        timestamp: null,
        source: 'transcript'
      }
    ]
    const findLastIndex = vi.spyOn(messages, 'findLastIndex')
    const slice = vi.spyOn(messages, 'slice')
    const filter = vi.spyOn(messages, 'filter')
    const map = vi.spyOn(messages, 'map')

    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: false }))
    })

    expect(findLastIndex).not.toHaveBeenCalled()
    expect(slice).not.toHaveBeenCalled()
    expect(filter).not.toHaveBeenCalled()
    expect(map).not.toHaveBeenCalled()
  })

  it('keeps a settled turn handler stable for NUL-delimited scope keys', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages: NativeChatMessage[] = [
        {
          id: 'u1',
          role: 'user',
          blocks: [{ type: 'text', text: 'go' }],
          timestamp: null,
          source: 'transcript'
        }
      ]
      act(() => {
        renderer = create(createElement(Harness, { messages, enabled: true }))
      })
      vi.setSystemTime(6_000)
      act(() => {
        renderer?.update(createElement(Harness, { messages, enabled: true, isWorking: false }))
      })
      const first = renderer!.root.findByType('result').props.disclosure.resolveRow(0, messages[0])

      const refreshed = [...messages]
      act(() => {
        renderer?.update(
          createElement(Harness, { messages: refreshed, enabled: true, isWorking: false })
        )
      })
      const second = renderer!.root
        .findByType('result')
        .props.disclosure.resolveRow(0, refreshed[0])

      // The row carries the key; the handler itself lives on the hook and stays
      // stable for the scope, so a re-render never disturbs a row's memo.
      expect(first.turnKey).toBe('u1')
      expect(second.turnKey).toBe('u1')
      const firstHandler = renderer!.root.findByType('result').props.disclosure.onToggleTurn
      expect(firstHandler).toBeTypeOf('function')
      act(() => {
        renderer?.update(
          createElement(Harness, { messages: [...refreshed], enabled: true, isWorking: false })
        )
      })
      expect(renderer!.root.findByType('result').props.disclosure.onToggleTurn).toBe(firstHandler)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps at most the latest 128 turns expanded', () => {
    vi.useFakeTimers()
    try {
      let messages: NativeChatMessage[] = []
      for (let index = 0; index < 129; index++) {
        messages = messages.concat(userMessage(`u${index}`))
        vi.setSystemTime(index * 2_000)
        act(() => {
          if (renderer) {
            renderer.update(createElement(Harness, { messages, enabled: true }))
          } else {
            renderer = create(createElement(Harness, { messages, enabled: true }))
          }
        })
        vi.setSystemTime(index * 2_000 + 1_000)
        act(() => {
          renderer?.update(createElement(Harness, { messages, enabled: true, isWorking: false }))
        })
        const disclosureNow = renderer!.root.findByType('result').props.disclosure
        const row = disclosureNow.resolveRow(index, messages[index])
        act(() => disclosureNow.onToggleTurn(row.turnKey))
      }

      const disclosure = renderer!.root.findByType('result').props.disclosure
      const expanded = messages.filter(
        (message, index) => disclosure.resolveRow(index, message).turnExpanded
      )
      expect(expanded).toHaveLength(128)
      expect(disclosure.resolveRow(0, messages[0]).turnExpanded).toBe(false)
      expect(disclosure.resolveRow(128, messages[128]).turnExpanded).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
