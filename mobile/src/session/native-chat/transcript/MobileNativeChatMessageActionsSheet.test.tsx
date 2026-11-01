import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { MobileNativeChatItemSourceContext } from '../mobile-native-chat-item-read'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import { ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX } from '../../../../../src/shared/orca-dispatch-status-prompt'
import { mobileNativeChatDisplayCopyText } from './mobile-native-chat-display-copy'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'

const { writeText, alert } = vi.hoisted(() => ({ writeText: vi.fn(), alert: vi.fn() }))
vi.mock('react-native', () => ({
  Alert: { alert },
  Image: 'Image',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Animated: {
    Text: 'Text',
    View: 'View',
    Value: class {
      setValue() {}
    },
    loop: () => ({ start() {}, stop() {} }),
    sequence: () => ({}),
    timing: () => ({})
  },
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 400, height: 800 })
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({
  Activity: 'Activity',
  AlertCircle: 'AlertCircle',
  AlertTriangle: 'AlertTriangle',
  ArrowUp: 'ArrowUp',
  ArrowUpRight: 'ArrowUpRight',
  Bot: 'Bot',
  Brain: 'Brain',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  Copy: 'Copy',
  Eye: 'Eye',
  FileMinus2: 'FileMinus2',
  FilePen: 'FilePen',
  FilePlus2: 'FilePlus2',
  Folder: 'Folder',
  Globe: 'Globe',
  Info: 'Info',
  ListChecks: 'ListChecks',
  MessageSquareMore: 'MessageSquareMore',
  Pencil: 'Pencil',
  Plug: 'Plug',
  Search: 'Search',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench',
  Terminal: 'Terminal',
  TextSelect: 'TextSelect',
  X: 'X',
  Edit3: 'Edit3',
  Trash2: 'Trash2'
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('../../../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
// Keep the real drawer lifecycle; only native animation completion is driven by the test.
// BottomDrawer also carries the option pager, which loads Reanimated at import.
vi.mock('react-native-reanimated', async () =>
  (await import('../../../test-support/reanimated-pager-stub')).reanimatedPagerStub()
)
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
    expect(nodes('Pressable')).toHaveLength(2)
    expect(nodes('Pressable').some((node) => node.props.disabled)).toBe(false)
    pressAction(0)
    expect(writeText.mock.calls).toEqual([[expected]])
    expect(onClose).not.toHaveBeenCalled()
    finishClosing()
    expect(onClose).toHaveBeenCalledOnce()
    expect(nodes('Modal')).toHaveLength(0)
  })

  it('takes Android long-press Copy/Select from the same current display policy as inline Copy', async () => {
    const from = {
      kind: 'agent' as const,
      senders: [],
      orchestration: { message: 'task' as const, runId: 'r', taskId: 't', dispatchId: 'd' }
    }
    const task = (body: string): NativeChatMessage => ({
      ...message,
      role: 'user',
      from,
      blocks: [
        {
          type: 'text',
          text: `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\nInstructions\n=== TASK ===\n${body}`
        }
      ]
    })
    const client = stubRpcClient()
    function Transcript({ current }: { current: NativeChatMessage }) {
      const [actions, setActions] = useState<NativeChatMessage | null>(null)
      const [shown, setShown] = useState(current)
      return createElement(
        MobileNativeChatItemSourceContext.Provider,
        {
          value: {
            client,
            sessionId: 'session',
            messageDetail: {
              raw: () => current,
              state: () => (shown === current ? 'available' : 'complete'),
              load: async () => {
                setShown(task('Recovered full task'))
              }
            }
          }
        },
        createElement(
          MobileNativeChatRowOverlaysContext.Provider,
          { value: { openImage: () => {}, openActions: setActions } },
          [
            createElement(MobileNativeChatMessage, { key: 'row', message: shown }),
            actions
              ? createElement(MobileNativeChatMessageActionsSheet, {
                  key: 'sheet',
                  message: actions,
                  onClose: () => setActions(null)
                })
              : null
          ]
        )
      )
    }
    const current: NativeChatMessage = { ...task('Preview'), shortened: true }
    act(() => {
      renderer = create(createElement(Transcript, { current }))
    })
    const recovery = nodes('Pressable').find(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function' &&
        node.findAll(
          (child) => String(child.type) === 'Text' && child.props.children === 'Show full message'
        ).length > 0
    )!
    await act(async () => recovery.props.onPress())
    const markdown = nodes('MobileMarkdown')[0]!
    expect(markdown.props.content).toBe('Recovered full task')
    const inline = renderer!.root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Copy message' && String(node.type) === 'Pressable'
    )[0]!
    await act(async () => inline.props.onPress())
    expect(writeText).toHaveBeenLastCalledWith(
      mobileNativeChatDisplayCopyText(task('Recovered full task'))
    )
    act(() => markdown.props.onLongPress())
    // Action labels live in Text children on the actual ActionSheetContent.
    const sheet = renderer!.root.findByType(MobileNativeChatMessageActionsSheet)
    const actionButtons = sheet.findAll((node) => String(node.type) === 'Pressable')
    act(() => actionButtons[0]!.props.onPress())
    expect(writeText).toHaveBeenLastCalledWith(markdown.props.content)
    act(() => nodes('MountedDrawer')[0]!.props.onHidden())
    act(() => markdown.props.onLongPress())
    const buttons = renderer!.root
      .findByType(MobileNativeChatMessageActionsSheet)
      .findAll((node) => String(node.type) === 'Pressable')
    act(() => buttons[1]!.props.onPress())
    act(() => nodes('MountedDrawer')[0]!.props.onHidden())
    expect(nodes('Text').find((node) => node.props.selectable)?.props.children).toBe(
      markdown.props.content
    )
    expect(current.blocks[0]).toMatchObject({ text: expect.stringContaining('=== TASK ===') })
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
