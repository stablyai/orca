import { createElement, useMemo, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { agentJournalTurnBody } from '../../../src/shared/agent-session-turn-record'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'
import { MobileNativeChatPageList } from './MobileNativeChatPageList'
import type {
  NativeChatMessage,
  NativeChatToolResultBlock
} from '../../../src/shared/native-chat-types'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import type * as MobileNativeChatItemReadModule from './mobile-native-chat-item-read'
import type * as MobileNativeChatRowPropsModule from './native-chat/transcript/use-mobile-native-chat-row-props'
import type * as MobileNativeChatRowProjectionModule from './native-chat/transcript/mobile-native-chat-row-projection'
import type * as MobileNativeChatMessageDetailModule from './native-chat/transcript/use-mobile-native-chat-message-detail'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { MobileNativeChatView } from './MobileNativeChatView'
import { MobileNativeChatRowContent } from './native-chat/transcript/MobileNativeChatRowItemSource'

vi.mock('react-native', async () => ({
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  Platform: { OS: 'web' },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  const chain = { runOnJS: () => chain, onStart: () => chain, onUpdate: () => chain }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  Brain: 'Brain',
  ChevronRight: 'ChevronRight',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
const itemReads = vi.hoisted(() => vi.fn())
vi.mock('./mobile-native-chat-item-read', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileNativeChatItemReadModule>()),
  readMobileNativeChatItem: itemReads
}))
const operations = vi.hoisted(() => ({
  resolve: new Array<string>(),
  compare: new Array<string>(),
  raw: new Array<string>(),
  state: new Array<string>()
}))
vi.mock('./native-chat/transcript/use-mobile-native-chat-row-props', async (importOriginal) => {
  const actual = await importOriginal<typeof MobileNativeChatRowPropsModule>()
  return {
    ...actual,
    resolveMobileNativeChatRowProps(
      ...args: Parameters<typeof actual.resolveMobileNativeChatRowProps>
    ) {
      operations.resolve.push(args[1].id)
      return actual.resolveMobileNativeChatRowProps(...args)
    }
  }
})
vi.mock('./native-chat/transcript/mobile-native-chat-row-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof MobileNativeChatRowProjectionModule>()
  return {
    equalMobileNativeChatRowContent(
      ...args: Parameters<typeof actual.equalMobileNativeChatRowContent>
    ) {
      operations.compare.push(args[1].message.id)
      return actual.equalMobileNativeChatRowContent(...args)
    }
  }
})
vi.mock(
  './native-chat/transcript/use-mobile-native-chat-message-detail',
  async (importOriginal) => {
    const actual = await importOriginal<typeof MobileNativeChatMessageDetailModule>()
    return {
      ...actual,
      useMobileNativeChatMessageDetail(
        ...args: Parameters<typeof actual.useMobileNativeChatMessageDetail>
      ) {
        const result = actual.useMobileNativeChatMessageDetail(...args),
          detail = result.detail
        return detail
          ? {
              ...result,
              detail: {
                ...detail,
                raw: (id: string) => {
                  operations.raw.push(id)
                  return detail.raw(id)
                },
                state: (id: string) => {
                  operations.state.push(id)
                  return detail.state(id)
                }
              }
            }
          : result
      }
    }
  }
)
const rendered = vi.hoisted(() => new Map<string, number>())
vi.mock('./native-chat/transcript/MobileNativeChatMessage', async () => {
  const React = await import('react')
  const { useMobileNativeChatFullMessage, MobileNativeChatToolOutput } =
    await import('./MobileNativeChatFullContent')
  const { MobileNativeChatGroupedThought } =
    await import('./native-chat/transcript/MobileNativeChatReasoningRow')
  return {
    MobileNativeChatMessage: React.memo(
      (props: { message: NativeChatMessage; workRun?: NativeChatMessage[] }) => {
        const full = useMobileNativeChatFullMessage(props.message)
        rendered.set(props.message.id, (rendered.get(props.message.id) ?? 0) + 1)
        return React.createElement(
          'ChatMessage',
          { ...props, recovery: full.recovery },
          full.showFull,
          ...(props.workRun ?? [])
            .filter((member) => member.role === 'reasoning')
            .map((member) =>
              React.createElement(MobileNativeChatGroupedThought, {
                key: member.id,
                message: member,
                fontScale: 1,
                expanded: true,
                onToggle: () => {}
              })
            ),
          ...(props.workRun ?? [props.message]).flatMap((member) =>
            member.blocks.flatMap((body, index) =>
              body.type === 'tool-result' && body.fullOutputItemId
                ? React.createElement(MobileNativeChatToolOutput, {
                    key: index,
                    body,
                    type: {},
                    rootIdentity: 'run',
                    positionKey: 'output'
                  })
                : []
            )
          )
        )
      }
    )
  }
})
vi.mock('./native-chat/input/MobileNativeChatPromptCard', () => ({
  MobileNativeChatPromptCard: 'PromptCard'
}))
vi.mock('./native-chat/transcript/MobileNativeChatLiveLine', () => ({
  MobileNativeChatLiveLine: 'LiveStatus'
}))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./native-chat/input/MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./native-chat/input/MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: 'ChatPermission'
}))
vi.mock('./native-chat/input/MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: 'ChatQuestion'
}))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => true }))
vi.mock('./native-chat/input/MobileNativeChatQueuedMessages', () => ({
  MobileNativeChatQueuedMessages: 'Queued'
}))
vi.mock('./native-chat/input/MobileNativeChatBackgroundTasks', () => ({
  MobileNativeChatBackgroundTasks: 'BackgroundTasks'
}))
vi.mock('./native-chat/visual/MobileNativeChatImageViewer', () => ({
  MobileNativeChatImageViewer: 'ImageViewer'
}))
vi.mock('./native-chat/transcript/MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'ActionsSheet'
}))
vi.mock('./native-chat/composer/MobileNativeChatComposer', () => ({
  MobileNativeChatDraftComposer: 'Composer'
}))

const stable = {
  onSend: async () => true,
  sendSurfaceId: 'perf-chat',
  getSendCompletionGeneration: () => 0,
  getComposerEditGeneration: () => 0,
  draftKey: null,
  onComposerTextChange: () => {},
  pending: [
    {
      id: 'pending',
      text: 'follow up',
      sentAt: 10
    }
  ],
  imagePreviewsByMessageId: { 'user-0': ['local:preview'] }
}

const itemSource = { client: stubRpcClient(), sessionId: 'session' }
function Harness({
  items,
  source = itemSource
}: {
  items: AgentJournalRenderItem[]
  source?: typeof itemSource | null
}) {
  const messages = useMemo(() => projectStructuredAgentSessionMessages(items, [], []), [items])
  const timing = useMobileStructuredAgentTurnTiming(
    { items, submissions: [], working: true },
    'live'
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overlay only reads these controller members; no other controller flow is mounted.
  const controller = {
    showNativeChat: true,
    nativeChatSession: { messages, status: 'ready' },
    nativeChatAgent: 'claude',
    nativeChatStructured: true,
    nativeChatTurnActive: true,
    nativeChatItemSource: source,
    nativeChatVisualSource: source,
    nativeChatSettledTurns: timing.settledTurns,
    nativeChatTurnJournal: timing.turnJournal,
    nativeChatWorkingStartedAt: timing.workingStartedAt,
    chatPending: stable.pending,
    chatImagePreviewsByMessageId: stable.imagePreviewsByMessageId,
    chatDraftKey: null,
    setChatComposerText: stable.onComposerTextChange,
    getChatComposerEditGeneration: stable.getComposerEditGeneration,
    nativeChatQueued: { cards: [], pause: null, sessionKey: 'session' }
  } as unknown as MobileNativeChatController
  return createElement(MobileNativeChatOverlay, {
    controller,
    onOpenFile: stable.onComposerTextChange,
    images: {
      attachments: [],
      isAttaching: false,
      attachImage: async () => {},
      removeAttachment: () => {},
      sendNativeChat: stable.onSend
    },
    onMicPress: undefined,
    micActive: false,
    dictationMode: undefined,
    onMicPressIn: () => {},
    onMicPressOut: () => {},
    inputLockReason: null,
    sendErrorMessage: null,
    onClearSendError: () => {},
    sendSurfaceId: source?.sessionId ?? stable.sendSurfaceId,
    sessionId: source?.sessionId ?? 'session',
    getSendCompletionGeneration: stable.getSendCompletionGeneration,
    keyboardInset: 0,
    hostName: null
  })
}

const textBody = (role: 'user' | 'assistant' | 'reasoning', text: string) => ({
  kind: 'message' as const,
  role,
  blocks: [{ type: 'text' as const, text }]
})

function journal(turns: number, text: string): AgentJournalRenderItem[] {
  const items: AgentJournalRenderItem[] = []
  const add = (itemId: string, body: AgentJournalRenderItem['body']) => {
    items.push({
      itemId,
      body,
      revision: 1,
      sequence: items.length + 1,
      observedAt: 1000 + items.length
    })
  }
  for (let i = 0; i < turns; i++) {
    const turnId = `turn-${i}`
    add(`user-${i}`, textBody('user', 'inspect the code'))
    add(`tool-${i}`, {
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'Read', callId: `call-${i}`, input: { path: 'index.ts' } },
        { type: 'tool-result', callId: `call-${i}`, output: 'contents' }
      ]
    })
    add(`reason-${i}`, textBody('reasoning', 'checking'))
    add(`answer-${i}`, textBody('assistant', 'finished'))
    add(
      `lifecycle-${i}`,
      agentJournalTurnBody({
        turnId,
        userItemId: `user-${i}`,
        state: 'completed',
        startedAt: 1000,
        completedAt: 5000,
        durationMs: 4000
      })
    )
  }
  add('live-user', textBody('user', 'continue'))
  add(
    'live-turn',
    agentJournalTurnBody({
      turnId: 'live',
      userItemId: 'live-user',
      state: 'running',
      startedAt: 6000
    })
  )
  add('live-answer', textBody('assistant', text))
  return items
}

const listeners = new Map<string, () => void>()
const scroller = {
  scrollTop: 0,
  scrollHeight: 10000,
  clientHeight: 500,
  addEventListener: (type: string, callback: () => void) => listeners.set(type, callback),
  removeEventListener: (type: string) => listeners.delete(type),
  querySelectorAll: () => [],
  querySelector: () => null,
  getBoundingClientRect: () => ({ top: 0, bottom: 500 })
}
const nodeMock = (element: { type: unknown }) =>
  element.type === 'ScrollView'
    ? { getScrollableNode: () => scroller, getInnerViewNode: () => null }
    : null
let renderer: ReactTestRenderer | null = null
function showElement(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element)
    } else {
      renderer = create(element, { createNodeMock: nodeMock })
    }
  })
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  rendered.clear()
  itemReads.mockReset()
  vi.useRealTimers()
})

function measure(turns: number, all: boolean) {
  scroller.scrollHeight = all ? 100 : 10000
  scroller.clientHeight = all ? 100 : 500
  const items = journal(turns, 'hello')
  showElement(createElement(Harness, { items }))
  expect(renderer!.root.findAllByType(MobileNativeChatPageList)).toHaveLength(1)
  const mounted = renderer!.root.findAll((node) => Object.is(node.type, 'ChatMessage'))
  const total =
    foldMobileNativeChatMessages(projectStructuredAgentSessionMessages(items, [], []), 'claude')
      .length + 1
  expect(mounted.length).toBe(all ? total : 24)
  const mountedIds = new Set(mounted.map((node) => node.props.message.id))
  const members = new Set(
    mounted.flatMap((node) =>
      (node.props.workRun ?? [node.props.message]).map((member: NativeChatMessage) => member.id)
    )
  )
  const maximum = { resolve: 0, compare: 0, raw: 0, state: 0 }
  for (let batch = 0; batch < 20; batch++) {
    rendered.clear()
    const updated = items.map((item) =>
      item.itemId === 'live-answer'
        ? {
            ...item,
            revision: batch + 2,
            body: textBody('assistant', `hello${'.'.repeat(batch + 1)}`)
          }
        : item
    )
    Object.values(operations).forEach((ids) => ids.splice(0))
    act(() => renderer!.update(createElement(Harness, { items: updated })))
    expect([...rendered.keys()]).toEqual(['live-answer'])
    for (const key of ['resolve', 'compare', 'raw', 'state'] as const) {
      expect(
        operations[key].every((id) =>
          (key === 'resolve' || key === 'compare' ? mountedIds : members).has(id)
        )
      ).toBe(true)
      expect(operations[key].length).toBeLessThanOrEqual(
        key === 'resolve' || key === 'compare' ? mounted.length : 2 * mounted.length
      )
      maximum[key] = Math.max(maximum[key], operations[key].length)
    }
  }
  return maximum
}

it.each([false, true])('bounds final work at mounted rows only, all history: %s', (all) => {
  const small = measure(10, all)
  act(() => renderer?.unmount())
  renderer = null
  const large = measure(100, all)
  for (const operation of ['resolve', 'compare', 'raw', 'state'] as const) {
    expect(large[operation]).toBeLessThanOrEqual(all ? 10 * small[operation] : small[operation])
  }
})
it('reuses footer rows during a command and returns them to the list afterward', () => {
  const base = journal(0, 'hello').map((item) =>
    item.body.kind === 'message' && item.body.role === 'user'
      ? { ...item, body: { ...item.body, command: { name: 'compact' } } }
      : item
  )
  const show = (text: string, holding = true) =>
    act(() => {
      const items = base.map((item) =>
        item.itemId === 'live-answer'
          ? { ...item, body: textBody('assistant', text) }
          : !holding && item.body.kind === 'message'
            ? { ...item, body: { ...item.body, command: undefined } }
            : item
      )
      const held: NativeChatMessage = {
        id: 'held',
        role: 'user',
        blocks: [{ type: 'text', text: 'next' }],
        timestamp: 3,
        source: 'transcript',
        queued: true
      }
      const folded = [...projectStructuredAgentSessionMessages(items, [], []), held]
      const element = createElement(MobileNativeChatView, {
        ...stable,
        pending: [],
        messages: folded,
        folded,
        status: 'ready',
        streaming: null,
        agentWorking: true,
        structuredActivityUi: true,
        turnJournal: { items, submissions: [] }
      })
      showElement(element)
    })
  const listed = (): string[] =>
    renderer!.root
      .findByType(MobileNativeChatPageList)
      .props.rows.map((row: NativeChatMessage) => row.id)
  show('hello')
  expect(listed()).not.toContain('held')
  rendered.clear()
  show('hello again')
  expect([...rendered.keys()]).toEqual(['live-answer'])
  show('done', false)
  expect(listed()).toContain('held')
})

it.each([false, true])(
  'recovers held text and fences equal-preview replacement, grouped: %s',
  async (grouped) => {
    const target = grouped ? 'reason-0' : 'answer-0'
    const head = grouped ? 'tool-0' : target
    const short = grouped ? 'checking' : 'finished'
    const items = journal(2, 'hello').map((item) =>
      item.itemId === target ? { ...item, shortened: true as const } : item
    )
    let source: typeof itemSource | null = itemSource
    const show = (batch: AgentJournalRenderItem[]) =>
      showElement(createElement(Harness, { items: batch, source }))
    const answer = () =>
      renderer!.root.find(
        (node) => Object.is(node.type, 'ChatMessage') && node.props.message.id === head
      )
    const recovery = () => {
      if (!grouped) {
        return answer().props.recovery
      }
      const button = answer().findAll(
        (node) =>
          Object.is(node.type, 'Pressable') &&
          node.findAll(
            (child) => Object.is(child.type, 'Text') && child.children.includes('Show full message')
          ).length > 0
      )[0]
      return button
        ? { load: button.props.disabled ? 'loading' : 'idle', onPress: button.props.onPress }
        : null
    }
    const shown = () =>
      (grouped
        ? answer().props.workRun.find((member: NativeChatMessage) => member.id === target)
        : answer().props.message
      ).blocks[0].text
    const complete: AgentJournalRenderItem = {
      itemId: target,
      sequence: 4,
      observedAt: 4,
      revision: 2,
      body: textBody(grouped ? 'reasoning' : 'assistant', `${short} FULL TAIL`)
    }
    scroller.scrollHeight = 10000
    vi.useFakeTimers()
    show(items)
    act(() => renderer!.root.findByType(MobileNativeChatPageList).props.onEndDistance(200, true))
    act(() => {
      listeners.get('pointerdown')!()
      listeners.get('pointerup')!()
    })
    expect(recovery().load).toBe('idle')
    itemReads.mockResolvedValueOnce(complete)
    rendered.clear()
    await act(async () => {
      recovery().onPress()
    })
    expect(itemReads).toHaveBeenCalledOnce()
    expect(shown()).toBe(short)
    expect(recovery()).toBeNull()
    expect([...rendered.keys()]).toEqual(grouped ? [head, target] : [head])
    act(() => void vi.advanceTimersByTime(400))
    expect(shown()).toBe(`${short} FULL TAIL`)

    const replaced = items.map((item) => (item.itemId === target ? { ...item, revision: 3 } : item))
    show(replaced)
    const pending = Promise.withResolvers<AgentJournalRenderItem>()
    itemReads.mockReturnValueOnce(pending.promise)
    await act(async () => {
      recovery().onPress()
    })
    expect(recovery().load).toBe('loading')
    show(replaced.map((item) => (item.itemId === target ? { ...item, revision: 4 } : item)))
    expect(recovery().load).toBe('idle')
    await act(async () => {
      pending.resolve(complete)
      await pending.promise
    })
    expect(shown()).toBe(short)
    expect(recovery()).not.toBeNull()
    for (const next of [
      { ...itemSource, client: stubRpcClient() },
      { ...itemSource, sessionId: 'other' }
    ]) {
      act(() => {
        listeners.get('pointerdown')!()
        listeners.get('pointerup')!()
      })
      const old = Promise.withResolvers<AgentJournalRenderItem>()
      itemReads.mockReturnValueOnce(old.promise)
      await act(async () => recovery().onPress())
      const previous = source
      source = next
      show(items)
      expect(shown()).toBe(short)
      expect(recovery().load).toBe('idle')
      await act(async () => {
        old.resolve(complete)
        await old.promise
      })
      expect(recovery()).not.toBeNull()
      itemReads.mockResolvedValueOnce(complete)
      await act(async () => recovery().onPress())
      expect(
        itemReads.mock.calls.slice(-2).map((call) => [call[0].client, call[0].sessionId])
      ).toEqual([
        [previous!.client, previous!.sessionId],
        [next.client, next.sessionId]
      ])
      expect(recovery()).toBeNull()
      source = null
      show(items)
      expect(recovery()).toBeNull()
      act(() => void vi.advanceTimersByTime(400))
      source = next
      show(items)
    }
    show(items.filter((item) => item.itemId !== target))
    expect(
      renderer!.root.findAll(
        (node) => Object.is(node.type, 'ChatMessage') && node.props.message.id === target
      )
    ).toHaveLength(0)
  }
)

const clipped = (): NativeChatToolResultBlock => ({
  type: 'tool-result',
  fullOutputItemId: 'tool-item',
  output: 'same preview\n… (1000 bytes)'
})
const message = (id: string, body: NativeChatToolResultBlock): NativeChatMessage => ({
  id,
  role: 'assistant',
  source: 'transcript',
  timestamp: 1,
  blocks: [body]
})
it.each([false, true])(
  'fences replaced equal tool previews, nested work run: %s',
  async (nested) => {
    const pending = Promise.withResolvers<AgentJournalRenderItem | null>()
    itemReads.mockReturnValueOnce(pending.promise)
    const source = { ...itemSource, details: [], load: async () => {} }
    const head = message('head', { type: 'tool-result', output: 'head' })
    const replace = () => {
      const row = message('row', clipped())
      showElement(
        createElement(MobileNativeChatRowContent, {
          scope: 'chat',
          source,
          message: nested ? head : row,
          workRun: nested ? [row] : undefined
        })
      )
    }
    replace()
    const button = () => renderer!.root.find((node) => Object.is(node.type, 'Pressable'))
    act(() => button().props.onPress())
    expect(button().props.disabled).toBe(true)
    replace()
    expect(button().props.disabled).toBe(false)
    const fullOutput = (head: string): AgentJournalRenderItem => ({
      itemId: 'tool-item',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'tool-call',
        name: 'Bash',
        input: {},
        state: 'completed',
        output: { head, byteLength: 1000, digest: 'fixture', truncated: false }
      }
    })
    await act(async () => {
      pending.resolve(fullOutput('old full output'))
      await pending.promise
    })
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('old full output')
    itemReads.mockResolvedValueOnce(fullOutput('current full output'))
    await act(async () => button().props.onPress())
    expect(itemReads).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(renderer!.toJSON())).toContain('current full output')
    replace()
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('current full output')
  }
)
