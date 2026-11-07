// @vitest-environment happy-dom
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import {
  mobileQueuedMessageCards,
  type MobileQueuedMessageCard
} from '../../mobile-structured-queued-message-cards'

import { createElement } from 'react'
import type * as QueuedCardRowModule from '../../MobileQueuedMessageCardRow'
import { MobileNativeChatLowerRegion } from '../MobileNativeChatLowerRegion.web'
import {
  useMobileNativeChatLowerGeometry,
  useMobileNativeChatLowerRegion
} from '../mobile-native-chat-lower-region-context'

import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MobileNativeChatQueuedMessages } from './MobileNativeChatQueuedMessages'
import {
  useMobileNativeChatComposerTray,
  type MobileNativeChatComposerTray
} from '../composer/use-mobile-native-chat-composer-tray'
import { useMobileQueuedMessageComposerActions } from '../../use-mobile-queued-message-composer-actions'
import type { MobileStructuredAgentMutate } from '../../use-mobile-structured-agent-mutation'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageMoveResult
} from '../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import type { StructuredAgentSessionMutationResult } from '../../mobile-structured-agent-session-rpc'
import {
  MobileAgentMessageContext,
  MobileAgentMessageOpenContext,
  createMobileAgentMessageSource
} from '../transcript/mobile-agent-message-context'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'
import { formatOrcaSessionAddress } from '../../../../../src/shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../src/shared/orca-session-address-test-fixture'

const rowRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../MobileQueuedMessageCardRow', async (importOriginal) => {
  const original = await importOriginal<typeof QueuedCardRowModule>()
  return {
    MobileQueuedMessageCardRow: (
      props: Parameters<typeof original.MobileQueuedMessageCardRow>[0]
    ) => {
      rowRenders.count++
      return createElement(original.MobileQueuedMessageCardRow, props)
    }
  }
})
let fontScale = 1
vi.mock('../../../components/DragReorderList', () => ({ DragReorderList: 'DragReorderList' }))
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
  ArrowUpRight: 'ArrowUpRight',
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
vi.mock('./MobileNativeChatBackgroundTasks', () => ({
  MobileNativeChatBackgroundTasks: 'BackgroundTasks'
}))
vi.mock('./MobileNativeChatDockedTaskList', () => ({
  MobileNativeChatDockedTaskList: 'DockedTaskList'
}))

vi.mock('../../MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))

function card(
  overrides: Partial<MobileQueuedMessageCard> & { messageId: string }
): MobileQueuedMessageCard {
  const text = overrides.text ?? `text of ${overrides.messageId}`
  return {
    position: 1,
    text,
    line: text,
    state: 'waiting',
    hold: overrides.state === 'returned' ? 'returned' : 'turn',
    needsAttention: false,
    caption: null,
    ...overrides
  }
}

describe('MobileNativeChatQueuedMessages', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    act(() => renderer?.unmount())
    renderer = null
    await activateMobileUiLocale('en')
  })

  async function mount(
    props: Parameters<typeof MobileNativeChatQueuedMessages>[0]
  ): Promise<ReactTestRenderer> {
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(createElement(MobileNativeChatQueuedMessages, props))
    })
    return mounted
  }

  function control(mounted: ReactTestRenderer, label: string, index = 0) {
    return mounted.root.findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label
    )[index]!
  }

  function sheet(mounted: ReactTestRenderer) {
    return mounted.root.find((node) => String(node.type) === 'ActionSheetModal')
  }

  it("closes a card's menu for good once the card leaves, even if it comes back", async () => {
    const mounted = await mount({ cards: [card({ messageId: 'a' }), card({ messageId: 'b' })] })
    await act(async () =>
      mounted.root.findAllByProps({ accessibilityLabel: 'More actions' })[0]!.props.onPress()
    )
    expect(sheet(mounted).props.visible).toBe(true)
    await act(async () => {
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, { cards: [card({ messageId: 'b' })] })
      )
    })
    expect(sheet(mounted).props.visible).toBe(false)
    await act(async () => {
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, {
          cards: [card({ messageId: 'a' }), card({ messageId: 'b' })]
        })
      )
    })
    expect(sheet(mounted).props.visible).toBe(false)
  })

  it("names a queued message's sender as its chat is now titled, and opens that chat", async () => {
    const coord = testOrcaSessionId('coord-chat')
    const from: AgentMessageSource = {
      kind: 'agent',
      senders: [
        {
          party: {
            address: formatOrcaSessionAddress(coord),
            terminalHandle: null,
            orcaSessionId: coord
          },
          name: 'Codex Chat',
          relation: 'coordinator'
        }
      ],
      orchestration: null
    }
    const source = createMobileAgentMessageSource()
    source.update(
      [
        {
          type: 'agent-session',
          id: `agent-session:${coord}`,
          sessionId: coord,
          agent: 'codex',
          title: 'Release coordinator',
          isActive: false
        }
      ],
      [],
      0
    )
    const open = vi.fn()
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(
        createElement(
          MobileAgentMessageOpenContext.Provider,
          { value: open },
          createElement(
            MobileAgentMessageContext.Provider,
            { value: source },
            createElement(MobileNativeChatQueuedMessages, {
              cards: [card({ messageId: 'q', from })]
            })
          )
        )
      )
    })
    const sender = mounted.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        node.findAll((child) => child.children.includes('Release coordinator')).length > 0
    )
    expect(sender.props.accessibilityRole).toBe('button')
    await act(async () => sender.props.onPress())
    expect(open).toHaveBeenCalledWith(from, from.senders[0])
  })

  it('the empty chord presses only the newest card where its own button would, and offers it only while that press would act, across chat switches', async () => {
    let tray!: MobileNativeChatComposerTray
    function Tray(props: Parameters<typeof useMobileNativeChatComposerTray>[0]['queued']) {
      tray = useMobileNativeChatComposerTray({
        queued: props,
        taskList: null,
        backgroundTasks: null
      })
      return createElement('View', null, tray.content)
    }
    const settles: ((accepted: boolean) => void)[] = []
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => settles.push(resolve)))
    const chatA = { sessionKey: 'a', cards: [card({ messageId: 'a1' }), card({ messageId: 'a2' })] }
    const chatB = { sessionKey: 'b', cards: [card({ messageId: 'b1' })] }
    const show = async (
      chat: typeof chatA,
      props: Partial<Parameters<typeof Tray>[0]> = {}
    ): Promise<void> => {
      await act(async () => {
        renderer ??= create(createElement('View'))
        renderer.update(createElement(Tray, { ...chat, agentWorking: true, onSend, ...props }))
      })
    }
    const press = (alternateSteers = true) => {
      let pressed = false
      act(() => {
        pressed = tray.steerHead!.run(alternateSteers)
      })
      return pressed
    }

    await show(chatA)
    expect(tray.steerHead!.steers(true)).toBe(true)
    expect(press()).toBe(true)
    expect(onSend).toHaveBeenLastCalledWith('a2')
    // On its way: neither offered nor admitted again, like a second tap.
    expect(tray.steerHead!.steers(true)).toBe(false)
    expect(press()).toBe(false)

    // Another chat's newest card is its own; A settling later must not clear B's hold.
    await show(chatB)
    expect(tray.steerHead!.steers(true)).toBe(true)
    expect(press()).toBe(true)
    await act(async () => settles[0]!(true))
    expect(tray.steerHead!.steers(true)).toBe(false)
    expect(press()).toBe(false)
    await act(async () => settles[1]!(true))
    expect(tray.steerHead!.steers(true)).toBe(true)

    // Back to A, whose list remounts: an action started there still holds until it settles.
    await show(chatA)
    expect(press()).toBe(true)
    await show(chatB)
    await show(chatA)
    expect(tray.steerHead!.steers(true)).toBe(false)
    expect(press()).toBe(false)
    await act(async () => settles[2]!(true))
    expect(tray.steerHead!.steers(true)).toBe(true)

    // No turn running (the paused queue after Stop): the newest card's own Send.
    await show(chatA, { agentWorking: false })
    expect(tray.steerHead!.steers(false)).toBe(true)
    const refusals: [Partial<Parameters<typeof Tray>[0]>, boolean][] = [
      [{}, false],
      [{ steerHeld: true }, true],
      [{ cards: [card({ messageId: 'a1' }), card({ messageId: 'a2', command: true })] }, true],
      [{ cards: [card({ messageId: 'a1' }), card({ messageId: 'a2', hold: 'sending' })] }, true],
      [{ cards: [card({ messageId: 'a1' }), card({ messageId: 'a2', hold: 'returned' })] }, true]
    ]
    for (const [props, alternateSteers] of refusals) {
      await show(chatA, props)
      expect(tray.steerHead!.steers(alternateSteers)).toBe(false)
      const sends = onSend.mock.calls.length
      expect(press(alternateSteers)).toBe(false)
      expect(onSend).toHaveBeenCalledTimes(sends)
    }
  })

  it('runs one action per card at a time, however fast its controls are tapped', async () => {
    let answer: (done: boolean) => void = () => undefined
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
    const onDelete = vi.fn(async () => true)
    const mounted = await mount({ cards: [card({ messageId: 'w' })], onSend, onDelete })
    // Tap all actions before disabled state renders to expose same-frame duplication.
    await act(async () => {
      control(mounted, 'Send this message').props.onPress()
      control(mounted, 'Send this message').props.onPress()
      control(mounted, 'Delete this queued message').props.onPress()
    })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onDelete).not.toHaveBeenCalled()
    expect(control(mounted, 'More actions').props.disabled).toBe(true)
    await act(async () => answer(true))
    expect(control(mounted, 'Send this message').props.disabled).toBe(false)
  })

  describe('a paused queue', () => {
    const waiting = card({ messageId: 'waiting-1', text: 'next' })

    async function mountPaused(
      props: Partial<Parameters<typeof MobileNativeChatQueuedMessages>[0]>
    ): Promise<ReactTestRenderer> {
      return mount({
        cards: [waiting],
        onSend: vi.fn(async () => true),
        onClearAll: vi.fn(async () => true),
        ...props
      })
    }

    it.each([100, 1000])('keeps pending work linear at %i cards', async (size) => {
      let counting = false
      let reads = 0
      let memberships = 0
      const ids = Array.from({ length: size }, (_, index) => `perf-card-${index}`)
      const cards = ids.map((messageId) =>
        Object.defineProperty(card({ messageId }), 'messageId', {
          get: () => {
            reads += Number(counting)
            return messageId
          }
        })
      )
      const has = Set.prototype.has
      const membership = vi.spyOn(Set.prototype, 'has')
      membership.mockImplementation(function (this: Set<unknown>, key: unknown) {
        if (counting && typeof key === 'string' && key.startsWith('perf-card-')) {
          memberships++
        }
        return has.call(this, key)
      })
      const send = Promise.withResolvers<boolean>()
      const clear = Promise.withResolvers<boolean>()
      const onClearAll = vi.fn(() => clear.promise)
      const onResume = vi.fn(async () => true)
      const onSend = vi.fn(() => send.promise)
      const mounted = await mountPaused({
        cards,
        pause: { reason: 'stopped' },
        onClearAll,
        onResume,
        onSend
      })
      const labels = ['Delete every queued message', 'Resume sending the queued messages']
      const steer = 'Send this message'
      const trigger = async (action: () => void) => {
        counting = true
        await act(async () => action())
        counting = false
      }
      // The last card forces the complete conflict scan; admission and settlement each rerender.
      await trigger(() => control(mounted, steer, size - 1).props.onPress())
      expect(onSend).toHaveBeenCalledExactlyOnceWith(ids.at(-1))
      expect(control(mounted, labels[0]!).props.disabled).toBe(true)
      await trigger(() => send.resolve(false))
      // Same frame, before disabled state renders: the shared admission check refuses the rest.
      await trigger(() => {
        control(mounted, labels[0]!).props.onPress()
        control(mounted, labels[1]!).props.onPress()
        control(mounted, steer).props.onPress()
      })
      expect(onClearAll).toHaveBeenCalledExactlyOnceWith(ids)
      expect([onResume.mock.calls.length, onSend.mock.calls.length]).toEqual([0, 1])
      const greyed = () => [...labels, steer].map((label) => control(mounted, label).props.disabled)
      expect(greyed()).toEqual([true, true, true])
      await trigger(() => clear.resolve(false))
      expect(greyed()).toEqual([false, false, false])
      // Four pending/settled renders plus admission: fixed linear budgets, independent of N.
      expect(reads).toBeGreaterThanOrEqual(4 * size)
      expect(reads).toBeLessThanOrEqual(36 * size)
      expect(memberships).toBeGreaterThanOrEqual(size)
      expect(memberships).toBeLessThanOrEqual(18 * size)
      console.info('queue operation counts', { cards: size, reads, memberships })
    })

    function resumeButton(mounted: ReactTestRenderer) {
      return control(mounted, 'Resume sending the queued messages')
    }

    it('Resume admits one press at a time and releases a lost answer for retry', async () => {
      let answer: (resumed: boolean) => void = () => undefined
      const onResume = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
      const mounted = await mountPaused({ pause: { reason: 'stopped' }, onResume })
      await act(async () => {
        resumeButton(mounted).props.onPress()
        resumeButton(mounted).props.onPress()
      })
      expect(onResume).toHaveBeenCalledOnce()
      expect(resumeButton(mounted).props.disabled).toBe(true)
      await act(async () => answer(false))
      expect(resumeButton(mounted).props.disabled).toBe(false)
      await act(async () => resumeButton(mounted).props.onPress())
      expect(onResume).toHaveBeenCalledTimes(2)
    })
  })

  it('admits one queue move synchronously, preserves unrelated actions and releases after settlement', async () => {
    const messages: AgentSessionQueuedMessage[] = ['a', 'b', 'c', 'd'].map(
      (messageId, position) => ({
        messageId,
        position,
        state: 'waiting',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: messageId }] }
      })
    )
    messages[2]!.body.from = { kind: 'agent', senders: [], orchestration: null }
    type MoveReply = StructuredAgentSessionMutationResult<AgentSessionQueuedMessageMoveResult>
    const first = Promise.withResolvers<MoveReply>()
    const second = Promise.withResolvers<MoveReply>()
    const mutate = vi
      .fn<(...args: Parameters<MobileStructuredAgentMutate>) => Promise<MoveReply>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const send = vi.fn(async () => true)
    function Harness({ published = messages }: { published?: AgentSessionQueuedMessage[] }) {
      const queue = useMobileQueuedMessageComposerActions({
        messages: published,
        sessionId: 's',
        sessionKey: 's',
        reorderCapable: true,
        enabled: true,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Vitest erases the generic result signature; this hook only requests queuedMessageMove, and both deferred replies are checked as MoveReply.
        mutate: mutate as MobileStructuredAgentMutate,
        onSendError: () => {}
      })
      return createElement(MobileNativeChatQueuedMessages, {
        cards: mobileQueuedMessageCards(queue.messages, []),
        onMove: queue.move,
        onSend: send
      })
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    const list = () => renderer!.root.find((node) => String(node.type) === 'DragReorderList')
    const ids = () => list().props.items.map((entry: MobileQueuedMessageCard) => entry.messageId)
    const queuedMove = list().props.onMove
    act(() => {
      expect(queuedMove({ movedId: 'c', beforeId: 'a' })).toBe(true)
      expect(queuedMove({ movedId: 'b', afterId: 'd' })).toBe(false)
    })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(ids()).toEqual(['c', 'a', 'b', 'd'])
    expect(list().props.canMove).toBeUndefined()
    expect(list().props.items[0].from).toBeDefined()
    expect(
      list().props.items.every((entry: MobileQueuedMessageCard) =>
        list().props.isMoveDisabled(entry)
      )
    ).toBe(true)
    const movedRow = list().props.renderRow(list().props.items[0])
    act(() => movedRow.props.onSend())
    expect(send).not.toHaveBeenCalled()
    const otherRow = list().props.renderRow(list().props.items[1])
    await act(async () => otherRow.props.onSend())
    expect(send).toHaveBeenCalledExactlyOnceWith('a')
    await act(async () => {
      first.resolve({
        status: 'accepted',
        value: { messageId: 'c', status: 'stale' },
        sameFence: true
      })
      await first.promise
    })
    expect(ids()).toEqual(['a', 'b', 'c', 'd'])
    expect(
      list().props.items.every(
        (entry: MobileQueuedMessageCard) => !list().props.isMoveDisabled(entry)
      )
    ).toBe(true)
    act(() => expect(list().props.onMove({ movedId: 'b', afterId: 'd' })).toBe(true))
    // The host republishes the moved order with fresh positions; cards sort by position.
    const published = [0, 2, 3, 1].map((index, position) => ({ ...messages[index]!, position }))
    await act(async () => renderer!.update(createElement(Harness, { published })))
    expect(ids()).toEqual(['a', 'c', 'd', 'b'])
    await act(async () => renderer!.unmount())
    renderer = null
    await act(async () => {
      second.resolve({
        status: 'accepted',
        value: { messageId: 'b', status: 'moved' },
        sameFence: true
      })
      await second.promise
    })
    expect(mutate).toHaveBeenCalledTimes(2)
  })
})

for (const population of [10, 100]) {
  it(`does no queue population work on geometry-only updates with ${population} cards`, async () => {
    const root = document.createElement('div')
    root.dataset.testid = 'native-chat-view'
    const viewport = document.createElement('div')
    const content = document.createElement('div')
    root.append(viewport)
    viewport.append(content)
    document.body.append(root)
    let height = 180
    Object.defineProperties(viewport, {
      clientHeight: { get: () => height },
      clientWidth: { value: 300 },
      scrollHeight: { value: 300 }
    })
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, 500))
    let visits = 0
    let operationRenders = 0
    let observedHeight = 0
    function GeometryConsumer() {
      observedHeight = useMobileNativeChatLowerGeometry().viewportHeight
      return null
    }
    function OperationConsumer() {
      useMobileNativeChatLowerRegion()
      operationRenders++
      return null
    }
    const cards = Array.from({ length: population }, (_, index) => {
      const item = card({ messageId: `queued-${index}` })
      Object.defineProperty(item, 'messageId', {
        get: () => {
          visits++
          return `queued-${index}`
        }
      })
      return item
    })
    let mounted: ReactTestRenderer | undefined
    const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const render = (items: MobileQueuedMessageCard[]) => (
      <MobileNativeChatLowerRegion>
        <GeometryConsumer />
        <OperationConsumer />
        <MobileNativeChatQueuedMessages cards={items} />
      </MobileNativeChatLowerRegion>
    )
    try {
      await act(async () => {
        mounted = create(render(cards), {
          createNodeMock: (element) => {
            const props = element.props
            if (
              typeof props === 'object' &&
              props !== null &&
              'testID' in props &&
              props.testID === 'native-chat-lower-scroll'
            ) {
              return { getScrollableNode: () => viewport }
            }
            return element.type === 'ScrollView' ? { scrollToEnd: () => {} } : content
          }
        })
      })
      await act(paint)
      await act(paint)
      expect(observedHeight).toBe(180)
      visits = 0
      operationRenders = 0
      rowRenders.count = 0
      await act(async () => {
        height = 120
        window.dispatchEvent(new Event('resize'))
        await paint()
      })
      expect(observedHeight).toBe(120)
      expect.soft(operationRenders).toBe(0)
      expect.soft(rowRenders.count).toBe(0)
      expect.soft(visits).toBe(0)
      await act(async () =>
        mounted!.update(
          render([...cards, card({ messageId: 'appended', text: 'A real new message' })])
        )
      )
      expect(rowRenders.count).toBeGreaterThan(0)
      expect(visits).toBeGreaterThan(0)
      expect(
        mounted!.root.findAllByProps({ children: 'A real new message' }).length
      ).toBeGreaterThan(0)
    } finally {
      await act(async () => mounted?.unmount())
      root.remove()
      vi.restoreAllMocks()
    }
  })
}
