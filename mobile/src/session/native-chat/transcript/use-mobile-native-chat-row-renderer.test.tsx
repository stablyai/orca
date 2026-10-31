import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { useMobileNativeChatRowRenderer } from './use-mobile-native-chat-row-renderer'

vi.mock('./MobileNativeChatRowItemSource', () => ({
  MobileNativeChatRow: () => null
}))

const message: NativeChatMessage = {
  id: 'm',
  role: 'assistant',
  timestamp: null,
  source: 'transcript',
  blocks: [{ type: 'text', text: 'hi' }]
}

function Probe({
  fontScale,
  pin
}: {
  fontScale: number
  pin: { frozen: ReturnType<typeof useMobileNativeChatRowRenderer> | null }
}): null {
  const renderItem = useMobileNativeChatRowRenderer({
    scope: 'chat',
    rowKeyOf: (row) => row.id,
    runOwners: new Map(),
    taskListPredecessors: new Map(),
    fontScale,
    structuredActivityUi: false,
    turns: { resolveRow: () => ({}), onToggleTurn: () => {} } as never,
    turnJournal: null,
    agent: null,
    receipts: null,
    actionablePromptIds: undefined
  })
  pin.frozen ??= renderItem
  return null
}

describe('useMobileNativeChatRowRenderer', () => {
  it('paints the current font scale from the callback a history touch froze', () => {
    const pin: { frozen: ReturnType<typeof useMobileNativeChatRowRenderer> | null } = {
      frozen: null
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(Probe, { fontScale: 1, pin }))
    })
    act(() => {
      renderer.update(createElement(Probe, { fontScale: 1.4, pin }))
    })
    const painted = pin.frozen?.({ item: message, index: 0 }) as ReactElement<{
      fontScale: number
    }>
    expect(painted.props.fontScale).toBe(1.4)
    act(() => renderer.unmount())
  })
})
