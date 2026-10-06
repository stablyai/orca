// The queued-card slot keeps one card list per conversation, so an action still in flight in one
// never disables the same control in another.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatQueuedSlot } from './use-mobile-native-chat-queued-slot'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  AlertCircle: 'AlertCircle',
  CornerDownRight: 'CornerDownRight',
  ListEnd: 'ListEnd',
  MoreHorizontal: 'MoreHorizontal',
  Pause: 'Pause',
  Pencil: 'Pencil',
  Play: 'Play',
  Send: 'Send',
  Trash2: 'Trash2'
}))

vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))

const CARD = {
  messageId: 'waiting-1',
  text: 'next',
  state: 'waiting' as const,
  paused: false,
  needsAttention: false,
  holdsQueue: false,
  caption: null
}

function Slot({
  sessionKey,
  onResume
}: {
  sessionKey: string
  onResume: () => Promise<boolean>
}): React.JSX.Element {
  const slot = useMobileNativeChatQueuedSlot({
    cards: [CARD],
    pause: { reason: 'stopped' },
    onResume,
    sessionKey
  })
  return createElement('View', null, slot.cards)
}

describe('useMobileNativeChatQueuedSlot', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it("never lets one conversation's pending Resume disable another's", async () => {
    const pending = vi.fn(() => new Promise<boolean>(() => undefined))
    const mounted = create(createElement('View'))
    renderer = mounted
    const resume = () =>
      mounted.root.findByProps({ accessibilityLabel: 'Resume sending the queued messages' })
    await act(async () => {
      mounted.update(createElement(Slot, { sessionKey: 'session-a', onResume: pending }))
    })
    await act(async () => resume().props.onPress())
    expect(resume().props.disabled).toBe(true)
    await act(async () => {
      mounted.update(createElement(Slot, { sessionKey: 'session-b', onResume: pending }))
    })
    expect(resume().props.disabled).toBe(false)
  })
})
