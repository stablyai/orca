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
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { MobileNativeChatView } from './MobileNativeChatView'
import { MobileNativeChatToolOutput } from './MobileNativeChatFullContent'
import { MobileNativeChatItemSourceContext } from './mobile-native-chat-item-read'
import { projectMobileNativeChatRows } from './mobile-native-chat-row-projection'

vi.mock('react-native', async () => {
  return {
    ActivityIndicator: 'ActivityIndicator',
    ScrollView: 'ScrollView',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})
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
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
const itemReads = vi.hoisted(() => vi.fn())
vi.mock('./mobile-native-chat-item-read', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileNativeChatItemReadModule>()),
  readMobileNativeChatItem: itemReads
}))
const operations = vi.hoisted(() => ({ resolve: 0, raw: 0, state: 0 }))
vi.mock('./use-mobile-native-chat-row-props', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-mobile-native-chat-row-props')>()
  const React = await import('react')
  return {
    ...actual,
    useMobileNativeChatRowProps(
      ...[messages, lookups, scope]: Parameters<typeof actual.useMobileNativeChatRowProps>
    ) {
      const counted = React.useMemo(
        () => ({
          ...lookups,
          resolveTurnRow: (...args: Parameters<typeof lookups.resolveTurnRow>) => {
            operations.resolve++
            return lookups.resolveTurnRow(...args)
          }
        }),
        [lookups]
      )
      return actual.useMobileNativeChatRowProps(messages, counted, scope)
    }
  }
})
vi.mock('./use-mobile-native-chat-message-detail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-mobile-native-chat-message-detail')>()
  return {
    ...actual,
    useMobileNativeChatMessageDetail(
      ...args: Parameters<typeof actual.useMobileNativeChatMessageDetail>
    ) {
      const result = actual.useMobileNativeChatMessageDetail(...args)
      const detail = result.detail
      return detail === null
        ? result
        : {
            ...result,
            detail: {
              ...detail,
              raw: (id: string) => {
                operations.raw++
                return detail.raw(id)
              },
              state: (id: string) => {
                operations.state++
                return detail.state(id)
              }
            }
          }
    }
  }
})
const rendered = vi.hoisted(() => new Map<string, number>())
vi.mock('./MobileNativeChatMessage', async () => {
  const React = await import('react')
  const { useMobileNativeChatFullMessage } = await import('./MobileNativeChatFullContent')
  const { MobileNativeChatVisualContext } = await import('./mobile-native-chat-visual-context')
  const { MobileNativeChatReplyRevealsContext } = await import('./mobile-native-chat-reply-reveals')
  const { MobileNativeChatDisclosureContext } =
    await import('./mobile-native-chat-disclosure-store')
  const { MobileNativeChatRowOverlaysContext } = await import('./mobile-native-chat-row-overlays')
  const { MobileNativeChatGrowthHoldContext } = await import('./mobile-native-chat-growth-hold')
  return {
    MobileNativeChatMessage: React.memo((props: { message: NativeChatMessage }) => {
      const full = useMobileNativeChatFullMessage(props.message)
      React.useContext(MobileNativeChatVisualContext)
      React.useContext(MobileNativeChatReplyRevealsContext)
      React.useContext(MobileNativeChatDisclosureContext)
      React.useContext(MobileNativeChatRowOverlaysContext)
      React.useContext(MobileNativeChatGrowthHoldContext)
      rendered.set(props.message.id, (rendered.get(props.message.id) ?? 0) + 1)
      return React.createElement(
        'ChatMessage',
        { ...props, recovery: full.recovery },
        full.showFull
      )
    })
  }
})
vi.mock('./MobileNativeChatPromptCard', () => ({ MobileNativeChatPromptCard: 'PromptCard' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => true }))
vi.mock('./MobileNativeChatQueuedMessages', () => ({ MobileNativeChatQueuedMessages: 'Queued' }))
vi.mock('./MobileNativeChatBackgroundTasks', () => ({
  MobileNativeChatBackgroundTasks: 'BackgroundTasks'
}))
vi.mock('./MobileNativeChatImageViewer', () => ({ MobileNativeChatImageViewer: 'ImageViewer' }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'ActionsSheet'
}))
vi.mock('./MobileNativeChatComposer', () => ({ MobileNativeChatComposer: 'Composer' }))

const stable = {
  onSend: async () => true,
  sendSurfaceId: 'perf-chat',
  getSendCompletionGeneration: () => 0,
  getComposerEditGeneration: () => 0,
  composerText: '',
  onComposerTextChange: () => {},
  pending: [
    {
      id: 'pending',
      text: 'follow up',
      sentAt: 10,
      baselineTailMessageId: 'live-user'
    }
  ],
  imagePreviewsByMessageId: { 'user-0': ['local:preview'] }
}

const itemSource = { client: stubRpcClient(), sessionId: 'session' }
const openFile = () => {}
function Harness({ items }: { items: AgentJournalRenderItem[] }) {
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
    nativeChatAgentWorking: true,
    nativeChatItemSource: itemSource,
    nativeChatVisualSource: itemSource,
    nativeChatSettledTurns: timing.settledTurns,
    nativeChatTurnJournal: timing.turnJournal,
    nativeChatWorkingStartedAt: timing.workingStartedAt,
    chatPending: stable.pending,
    chatImagePreviewsByMessageId: stable.imagePreviewsByMessageId,
    chatComposerText: '',
    setChatComposerText: stable.onComposerTextChange,
    getChatComposerEditGeneration: stable.getComposerEditGeneration,
    nativeChatQueued: { cards: [], pause: null, sessionKey: 'session' }
  } as unknown as MobileNativeChatController
  return createElement(MobileNativeChatOverlay, {
    controller,
    onOpenFile: openFile,
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
    sendSurfaceId: stable.sendSurfaceId,
    sessionId: 'session',
    getSendCompletionGeneration: stable.getSendCompletionGeneration,
    keyboardInset: 0
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

let renderer: ReactTestRenderer | null = null
function showElement(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element)
    } else {
      renderer = create(element)
    }
  })
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  rendered.clear()
  itemReads.mockReset()
})

function measure(turns: number) {
  // Retain every loaded row by reaching the page's scroll-driven draw expansion.
  const scroller = {
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => []
  }
  const items = journal(turns, 'hello')
  act(() => {
    renderer = create(createElement(Harness, { items }), {
      createNodeMock: (element) =>
        element.type === 'ScrollView'
          ? { getScrollableNode: () => scroller, getInnerViewNode: () => null }
          : null
    })
  })
  expect(renderer!.root.findAllByType(MobileNativeChatPageList)).toHaveLength(1)
  const mounted = renderer!.root.findAll((node) => Object.is(node.type, 'ChatMessage'))
  expect(mounted.length).toBe(
    foldMobileNativeChatMessages(projectStructuredAgentSessionMessages(items, [], []), 'claude')
      .length + 1
  )
  expect(mounted.some((node) => node.props.workRun?.length > 1)).toBe(true)
  expect(
    mounted.filter((node) => node.props.turnStatus?.workedSeconds === 4).length
  ).toBeGreaterThanOrEqual(turns)
  const preview = mounted.find((node) => node.props.message.id === 'user-0')!
  expect(preview.props.message.blocks).toContainEqual({ type: 'image-ref', url: 'local:preview' })
  expect(mounted.some((node) => node.props.message.id === 'pending')).toBe(true)
  const maximum = { resolve: 0, raw: 0, state: 0 }
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
    Object.assign(operations, { resolve: 0, raw: 0, state: 0 })
    act(() => renderer!.update(createElement(Harness, { items: updated })))
    expect([...rendered.keys()]).toEqual(['live-answer'])
    expect(operations.resolve).toBeLessThanOrEqual(mounted.length)
    for (const key of ['resolve', 'raw', 'state'] as const) {
      maximum[key] = Math.max(maximum[key], operations[key])
    }
    // Work-run members appear in the owner's details and their own row.
    expect(operations.raw).toBeLessThanOrEqual(2 * mounted.length)
    expect(operations.state).toBeLessThanOrEqual(2 * mounted.length)
  }
  return maximum
}

it('bounds streaming row renders and upstream lookup work at N and 10N', () => {
  const small = measure(10)
  act(() => renderer?.unmount())
  renderer = null
  const large = measure(100)
  for (const operation of ['resolve', 'raw', 'state'] as const) {
    expect(large[operation]).toBeLessThanOrEqual(10 * small[operation])
  }
})
it('reuses footer rows during a command and returns them to the list afterward', () => {
  const show = (text: string, holding = true) =>
    act(() => {
      const items = journal(0, text).map((item) =>
        item.body.kind === 'message' && item.body.role === 'user' && holding
          ? { ...item, body: { ...item.body, command: { name: 'compact' } } }
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

it('loads full row text without redrawing other rows and fences a replaced shortened row', async () => {
  const items = journal(2, 'hello').map((item) =>
    item.itemId === 'answer-0' ? { ...item, shortened: true as const } : item
  )
  const show = (batch: AgentJournalRenderItem[]) =>
    showElement(createElement(Harness, { items: batch }))
  const answer = () =>
    renderer!.root.find(
      (node) => Object.is(node.type, 'ChatMessage') && node.props.message.id === 'answer-0'
    )
  const complete: AgentJournalRenderItem = {
    itemId: 'answer-0',
    sequence: 4,
    observedAt: 4,
    revision: 2,
    body: textBody('assistant', 'finished FULL TAIL')
  }
  show(items)
  expect(answer().props.recovery.load).toBe('idle')
  itemReads.mockResolvedValueOnce(complete)
  rendered.clear()
  await act(async () => {
    answer().props.recovery.onPress()
  })
  expect(itemReads).toHaveBeenCalledOnce()
  expect(answer().props.message.blocks[0].text).toBe('finished FULL TAIL')
  expect(answer().props.recovery).toBeNull()
  expect([...rendered.keys()]).toEqual(['answer-0'])

  const replaced = items.map((item) =>
    item.itemId === 'answer-0' ? { ...item, revision: 3 } : item
  )
  show(replaced)
  const pending = Promise.withResolvers<AgentJournalRenderItem>()
  itemReads.mockReturnValueOnce(pending.promise)
  await act(async () => {
    answer().props.recovery.onPress()
  })
  expect(answer().props.recovery.load).toBe('loading')
  show(replaced.map((item) => (item.itemId === 'answer-0' ? { ...item, revision: 4 } : item)))
  expect(answer().props.recovery.load).toBe('idle')
  await act(async () => {
    pending.resolve(complete)
    await pending.promise
  })
  expect(answer().props.message.blocks[0].text).toBe('finished')
  expect(answer().props.recovery).not.toBeNull()
})

const clipped = (): NativeChatToolResultBlock => ({
  type: 'tool-result',
  callId: 'call',
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
type Row = { message: NativeChatMessage; workRun?: NativeChatMessage[] }

it.each([false, true])(
  'fences replaced equal tool previews, nested work run: %s',
  async (nested) => {
    const pending = Promise.withResolvers<AgentJournalRenderItem | null>()
    itemReads.mockReturnValueOnce(pending.promise)
    let previous: ReturnType<typeof projectMobileNativeChatRows<Row>> | undefined
    const replace = () => {
      const row = message('row', clipped())
      previous = projectMobileNativeChatRows<Row>(
        [
          nested
            ? { message: message('head', { type: 'tool-result', output: 'head' }), workRun: [row] }
            : { message: row }
        ],
        previous
      )
      const shown = nested ? previous.rows[0]!.workRun![0]! : previous.rows[0]!.message
      const body = shown.blocks[0]
      if (body?.type !== 'tool-result') {
        throw new Error('Expected projected tool output')
      }
      showElement(
        createElement(
          MobileNativeChatItemSourceContext.Provider,
          { value: itemSource },
          createElement(MobileNativeChatToolOutput, {
            body,
            type: {},
            rootIdentity: 'run',
            positionKey: 'output'
          })
        )
      )
    }
    replace()
    const button = () => renderer!.root.findByType('Pressable')
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
        output: { head, byteLength: 1000, truncated: false }
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
  }
)
