import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'

const { writeText, alert } = vi.hoisted(() => ({ writeText: vi.fn(), alert: vi.fn() }))
vi.mock('react-native', () => ({
  Alert: { alert },
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({
  Copy: 'Copy',
  TextSelect: 'TextSelect',
  X: 'X',
  Edit3: 'Edit3',
  Trash2: 'Trash2'
}))
vi.mock('../../../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
// Keep the real drawer lifecycle; only native animation completion is driven by the test.
vi.mock('../../../components/mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'MountedDrawer'
}))

const message: NativeChatMessage = {
  id: 'reply',
  source: 'transcript',
  role: 'assistant',
  timestamp: null,
  blocks: [{ type: 'text', text: 'First words' }]
}

const deniedNotice: NativeChatMessage = {
  ...message,
  role: 'system',
  blocks: [
    {
      type: 'text',
      text: 'First words',
      tone: 'error',
      providerFrame: {
        provider: 'claude',
        kind: 'message:system:permission_denied',
        payload: { head: '{}', byteLength: 2, digest: 'synthetic', truncated: false }
      }
    }
  ]
}

describe('message selection actions', () => {
  let renderer: ReactTestRenderer | null = null
  const onClose = vi.fn()
  const nodes = (type: string) => renderer!.root.findAll((node) => String(node.type) === type)
  const render = (value = message) => {
    act(() => {
      renderer = create(
        createElement(MobileNativeChatMessageActionsSheet, { message: value, onClose })
      )
    })
  }
  const pressAction = (index: number) => act(() => nodes('Pressable')[index]!.props.onPress())
  const finishClosing = () => act(() => nodes('MountedDrawer')[0]!.props.onHidden())

  beforeEach(() => {
    vi.clearAllMocks()
    writeText.mockResolvedValue(undefined)
  })
  afterEach(() => act(() => renderer?.unmount()))

  it.each([message, deniedNotice])(
    'selects a stable $role snapshot after drawer removal',
    (value) => {
      render(value)
      act(() =>
        renderer!.update(
          createElement(MobileNativeChatMessageActionsSheet, {
            message: {
              ...value,
              blocks: [{ type: 'text', text: 'First words plus streamed text' }]
            },
            onClose
          })
        )
      )
      pressAction(1)
      expect(nodes('MountedDrawer')[0]!.props.visible).toBe(false)
      expect(nodes('Modal')).toHaveLength(0)
      expect(onClose).not.toHaveBeenCalled()
      finishClosing()
      expect(nodes('MountedDrawer')).toHaveLength(0)
      expect(nodes('Modal')).toHaveLength(1)
      const selected = nodes('Text').find((node) => node.props.selectable)
      expect(selected?.props.children).toBe('First words')
      act(() => nodes('Modal')[0]!.props.onRequestClose())
      expect(onClose).toHaveBeenCalledOnce()
    }
  )

  it('closes selection with the accessible close button', () => {
    render()
    pressAction(1)
    finishClosing()
    const close = nodes('Pressable').find((node) => node.props.accessibilityLabel === 'Close')
    expect(close?.props.accessibilityRole).toBe('button')
    act(() => close!.props.onPress())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each([message, deniedNotice])(
    'copies $role prose and dismisses after drawer close',
    (value) => {
      render(value)
      pressAction(0)
      expect(writeText).toHaveBeenCalledWith('First words')
      expect(onClose).not.toHaveBeenCalled()
      finishClosing()
      expect(onClose).toHaveBeenCalledOnce()
      expect(nodes('Modal')).toHaveLength(0)
    }
  )

  it.each([
    [
      'user',
      'Please repair:\n::orca-visual{file="usage.html"}\nKeep this.',
      'Please repair:\n::orca-visual{file="usage.html"}\nKeep this.'
    ],
    ['user', '::orca-visual{file="usage.html"}', '::orca-visual{file="usage.html"}'],
    ['assistant', 'Chart:\n::orca-visual{file="usage.html"}\nDone.', 'Chart:\nDone.'],
    [
      'assistant',
      '```text\n::orca-visual{file="example.html"}\n```',
      '```text\n::orca-visual{file="example.html"}\n```'
    ]
  ] as const)('copies the %s source %j through Android message actions', (role, text, expected) => {
    render({ ...message, role, blocks: [{ type: 'text', text }] })
    expect(nodes('Pressable').map((node) => node.props.disabled)).toEqual([undefined, undefined])
    pressAction(0)
    expect(writeText.mock.calls).toEqual([[expected]])
    expect(onClose).not.toHaveBeenCalled()
    finishClosing()
    expect(onClose).toHaveBeenCalledOnce()
    expect(nodes('Modal')).toHaveLength(0)
  })

  it('surfaces clipboard rejection', async () => {
    writeText.mockRejectedValue(new Error('Clipboard unavailable'))
    render()
    await act(async () => pressAction(0))
    expect(alert).toHaveBeenCalledWith('Copy failed', 'Clipboard unavailable')
  })

  it('dismisses without selecting when the drawer is cancelled', () => {
    render()
    act(() => nodes('MountedDrawer')[0]!.props.onClose())
    finishClosing()
    expect(onClose).toHaveBeenCalledOnce()
    expect(nodes('Modal')).toHaveLength(0)
  })

  it('disables actions when the message has no copyable prose', () => {
    render({ ...message, blocks: [{ type: 'image-ref', path: '/image.png' }] })
    expect(nodes('Pressable').map((node) => node.props.disabled)).toEqual([true, true])
    expect(writeText).not.toHaveBeenCalled()
  })
})
