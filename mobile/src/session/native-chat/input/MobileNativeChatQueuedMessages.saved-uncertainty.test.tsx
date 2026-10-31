import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { ActionSheetAction } from '../../../components/ActionSheetModal'
import { MobileNativeChatQueuedMessages } from './MobileNativeChatQueuedMessages'
import { mobileQueuedMessageCards } from '../../mobile-structured-queued-message-cards'
import { queuedMessagesQueuePause } from '../../../../../src/shared/structured-agent-session-queued-cards'
import type { AgentSessionQueuedMessage } from '../../../../../src/shared/agent-session-wire'

const fontScale = 1
vi.mock('../../../components/DragReorderList', () => ({ DragReorderList: 'DragReorderList' }))
vi.mock('../../MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react')
  return {
    default: { ScrollView: 'ScrollView' },
    useAnimatedRef: () => useRef(null),
    useSharedValue: (value: unknown) => useRef({ value }).current
  }
})

vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale }),
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Image: 'Image',
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  CornerDownRight: 'CornerDownRight',
  ListEnd: 'ListEnd',
  MoreHorizontal: 'MoreHorizontal',
  Pencil: 'Pencil',
  Play: 'Play',
  Send: 'Send',
  Trash2: 'Trash2',
  X: 'X'
}))

vi.mock('../../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

async function mount(
  props: Parameters<typeof MobileNativeChatQueuedMessages>[0]
): Promise<ReactTestRenderer> {
  const mounted = create(createElement('View'))
  renderer = mounted
  await act(async () => mounted.update(createElement(MobileNativeChatQueuedMessages, props)))
  return mounted
}

function texts(mounted: ReactTestRenderer): unknown[] {
  return mounted.root
    .findAll((node) => String(node.type) === 'Text' && !node.props.accessibilityElementsHidden)
    .map((node) => node.props.children)
}

function sheet(mounted: ReactTestRenderer) {
  return mounted.root.find((node) => String(node.type) === 'ActionSheetModal')
}

it('omits saved uncertainty words without changing the returned card, suffix or exact actions', async () => {
  const saved: AgentSessionQueuedMessage = {
    messageId: 'saved',
    position: 1,
    state: 'returned',
    returnedReason: "Couldn't confirm whether this was sent. It hasn't been resent.",
    returnedRejection: { kind: 'unconfirmed' },
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Original full prose before the image.' },
        { type: 'image-ref', path: '/tmp/saved.png' },
        { type: 'text', text: 'Original full prose after the image.' }
      ]
    }
  }
  const original = structuredClone(saved)
  const cards = mobileQueuedMessageCards(
    [
      saved,
      {
        ...saved,
        messageId: 'later',
        position: 2,
        state: 'waiting',
        returnedRejection: undefined,
        returnedReason: undefined
      }
    ],
    [],
    { statedFailures: [{ kind: 'unconfirmed' }] }
  )
  const pause = queuedMessagesQueuePause(cards, { reason: 'stopped' })
  expect(cards[0]).toMatchObject({
    messageId: 'saved',
    state: 'returned',
    hold: 'returned',
    needsAttention: true,
    caption: null,
    images: [{ type: 'image-ref', path: '/tmp/saved.png' }]
  })
  expect(cards[1]).toMatchObject({
    messageId: 'later',
    hold: 'behind-returned',
    caption: 'Waiting — a message ahead needs attention'
  })
  expect(pause).toBeNull()
  const onSend = vi.fn(async () => true)
  const onDelete = vi.fn(async () => true)
  const onEdit = vi.fn(async () => true)
  const mounted = await mount({ cards, pause, onSend, onDelete, onEdit })
  expect(texts(mounted)).toContain(
    'Original full prose before the image.\nOriginal full prose after the image.'
  )
  expect(texts(mounted).join()).not.toContain('confirm')
  expect(
    mounted.root.findAllByProps({ accessibilityLabel: 'Resume sending the queued messages' })
  ).toHaveLength(0)
  const row = mounted.root.findAllByProps({ testID: 'queued-card-row' })[0]!
  await act(async () =>
    row.findByProps({ accessibilityLabel: 'Send this message again' }).props.onPress()
  )
  await act(async () =>
    row.findByProps({ accessibilityLabel: 'Delete this queued message' }).props.onPress()
  )
  await act(async () => row.findByProps({ accessibilityLabel: 'More actions' }).props.onPress())
  const actions: ActionSheetAction[] = sheet(mounted).props.actions
  expect(actions.map((action) => action.label)).toEqual(['Edit message'])
  await act(async () => actions[0]!.onPress())
  expect(onSend).toHaveBeenCalledExactlyOnceWith('saved')
  expect(onDelete).toHaveBeenCalledExactlyOnceWith('saved')
  expect(onEdit).toHaveBeenCalledExactlyOnceWith('saved')
  expect(saved).toEqual(original)
})
