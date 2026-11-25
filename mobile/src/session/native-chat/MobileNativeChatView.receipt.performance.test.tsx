import {
  activityRenders,
  listRenders,
  messageRenders,
  placement,
  viewRenders
} from './mobile-native-chat-view-receipt.test-fixture'
import { createMobileNativeChatTailViewport } from './transcript/viewport/mobile-native-chat-tail-viewport'
import { MobileNativeChatPageList } from './transcript/viewport/MobileNativeChatPageList'
import { MobileNativeChatMessageTime } from './transcript/messages/MobileNativeChatMessageTime'
import { StructuredAgentWorkingGate } from './transcript/sending/structured-agent-sending-scope'
import { useMobileStructuredSends } from './composer/delivery/use-mobile-structured-sends'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import { Platform } from 'react-native'
import { MobileNativeChatRowList } from './transcript/MobileNativeChatRowList'
import { createStructuredAgentSendingSource } from '../../../../src/shared/agent-session/view/structured-agent-sending-source'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { createElement, useMemo, type ComponentProps } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type {
  AgentSessionHistoryPage,
  AgentSessionLatestTurn,
  AgentSessionSubscribeEvent
} from '../../../../src/shared/agent-session/agent-session-wire'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import type { StructuredAgentSessionAction } from '../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { StructuredAgentSendingSource } from '../../../../src/shared/agent-session/view/structured-agent-sending-source'
import type { OrchestrationWorkerApprovalEntry } from '../../../../src/shared/orchestration/orchestration-crew'
import { MobileNativeChatView } from './MobileNativeChatView'
import { useMobileStructuredAgentState } from './agent-session/use-mobile-structured-agent-state'
import { useMobileStructuredTurnIndicator } from './transcript/ingestion/use-mobile-structured-turn-indicator'
import { useMobileStructuredTranscript } from './transcript/ingestion/use-mobile-structured-transcript'

vi.mock('./agent-session/structured-session-operation-id', () => ({
  structuredSessionOperationId: () => 'receipt-test'
}))

function sendingIds(source: StructuredAgentSendingSource | undefined): string[] {
  return source ? [...source.candidates].filter((id) => source.getId(id)) : []
}

function shows(tree: ReactTestRenderer, text: string): boolean {
  const textOf = (node: ReactTestInstance | string): string =>
    typeof node === 'string' ? node : node.children.map(textOf).join('')
  return tree.root.findAll((node) => node.type === 'span' && textOf(node) === text).length > 0
}

const EPOCH = 'receipt-epoch'
const SEND: AgentJournalSubmission = {
  clientMessageId: 'opener',
  fence: 2,
  payloadFingerprint: 'test',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 1000,
  resolvedAt: null,
  handedOverAt: 1400
}

function page(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  const cursor = (item: AgentJournalRenderItem | undefined) =>
    item ? { epoch: EPOCH, sequence: item.sequence } : null
  const oldest = cursor(items[0])
  const newest = cursor(items.at(-1))
  return {
    sessionId: 'chat',
    epoch: EPOCH,
    direction: 'before',
    items,
    removedItemIds: [],
    submissions,
    window: { oldest, newest, nextCursor: newest ?? { epoch: EPOCH, sequence: 0 } },
    hasOlder: true,
    hasNewer: false
  } satisfies AgentSessionHistoryPage
}

function batch(
  sequence: number,
  submissions: AgentJournalSubmission[],
  items: AgentJournalRenderItem[] = [],
  latestTurn?: AgentSessionLatestTurn | null,
  queuedMessages?: AgentSessionQueuedMessage[]
): StructuredAgentSessionAction {
  return {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 'chat',
      latestTurn,
      actionablePromptIds: [],
      working: latestTurn != null,
      ...(queuedMessages ? { queuedMessages } : {}),
      batch: { cursor: { epoch: EPOCH, sequence }, items, removedItemIds: [], submissions }
    }
  }
}

const NO_PENDING = [] as const
const noSubscription = () => () => {}

const APPROVAL: OrchestrationWorkerApprovalEntry = {
  at: new Date(2000).toISOString(),
  askedAt: new Date(1600).toISOString(),
  approval: {
    v: 1,
    approvalId: 'closed',
    state: 'answered',
    worker: { handle: 'worker', dispatchId: 'dispatch', taskId: 'task' },
    summary: { title: 'Bash', detail: null, reason: null },
    allowedActions: []
  },
  worker: {
    partyKey: 'worker',
    label: 'Worker',
    role: 'worker',
    agentKind: 'claude',
    status: 'idle'
  }
}
const WORKER_APPROVALS = { open: NO_PENDING, receipts: [APPROVAL], answer: async () => true }

// PR #45057: receipt delivery used to render the phone chat again and reposition every approval.
it.each([4096, 40960])(
  'keeps the mounted mobile view and approval placement asleep on receipt with %i loaded rows',
  async (rowCount) => {
    vi.useFakeTimers()
    let rowReads = 0
    let timestampReads = 0
    let sessionRenders = 0
    let thinking = false
    let sendingSource: StructuredAgentSendingSource | undefined
    const streams = new Map<string, (event: AgentSessionSubscribeEvent) => void>()
    const client: Partial<RpcClient> = {
      getState: () => 'connected',
      onStateChange: noSubscription,
      sendRequest: async () => ({ id: 'receipt-test', ok: true, result: null }),
      subscribe: (method, _options, receive) => {
        streams.set(method, (event) => receive(event))
        return () => {
          streams.delete(method)
        }
      }
    }
    const items = Array.from({ length: rowCount }, (_, index): AgentJournalRenderItem => ({
      itemId: index === 0 ? 'orca:opener' : `history:${index}`,
      revision: 0,
      sequence: index + 2,
      observedAt: 1000,
      get body(): AgentJournalRenderItem['body'] {
        rowReads += 1
        return { kind: 'message', role: index === 0 ? 'user' : 'assistant', blocks: [] }
      }
    }))
    const latestTurn = {
      itemId: 'turn-lifecycle:run',
      observedAt: 1000,
      turn: { turnId: 'run', state: 'running', startedAt: 1000, userItemId: 'orca:opener' }
    } satisfies AgentSessionLatestTurn
    function Session({ hostStopping = false }: { hostStopping?: boolean }) {
      sessionRenders += 1
      const read = useMobileStructuredAgentState({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake implements every RPC method the transcript subscription needs.
        client: client as RpcClient,
        sessionId: 'chat',
        sessionKey: 'chat',
        enabled: true,
        connected: true
      })
      const { state } = read
      const turnId = state.latestTurn?.turn.turnId ?? null
      const isWorking = state.working === true
      const { sending, messages, timing } = useMobileStructuredTranscript(
        { agent: 'claude', sessionKey: 'chat', read, optimistic: NO_PENDING, turnId },
        isWorking
      )
      sendingSource = sending
      const turnIndicator = useMobileStructuredTurnIndicator({
        state,
        turnId,
        isWorking,
        canStop: isWorking,
        hostStopping,
        stopPressed: false,
        queueCapable: true,
        queueFollowUps: true,
        queueSendsNext: false
      })
      thinking = turnIndicator.thinking
      const dated = useMemo(
        () =>
          messages.map((message) => ({
            ...message,
            get timestamp() {
              timestampReads += 1
              return message.timestamp
            }
          })),
        [messages]
      )
      return state.status !== 'ready'
        ? null
        : createElement(MobileNativeChatView, {
            messages: dated,
            folded: dated,
            status: 'ready',
            agent: 'claude',
            agentWorking: isWorking,
            structuredActivityUi: true,
            workingStartedAt: 1000,
            turnIndicator,
            turnJournal: timing.turnJournal,
            structuredSending: sending,
            workerApprovals: WORKER_APPROVALS,
            streaming: null,
            sendSurfaceId: 'chat',
            getSendCompletionGeneration: () => 0,
            getComposerEditGeneration: () => 0,
            pending: [],
            draftKey: null,
            onComposerTextChange: () => {},
            onSend: async () => true
          })
    }
    let mounted!: ReactTestRenderer
    act(() => {
      mounted = create(createElement(Session))
    })
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150)
      })
      const receive = streams.get('agentSession.subscribe')!
      act(() =>
        receive({
          type: 'snapshot',
          sessionId: 'chat',
          page: { ...page(items, [SEND]), latestTurn, actionablePromptIds: [], working: true },
          fence: SEND.fence
        })
      )
      expect(thinking).toBe(false)
      expect(shows(mounted, 'Sending…')).toBe(true)
      expect(shows(mounted, 'Working')).toBe(false)
      expect(placement).toHaveBeenCalled()
      expect(listRenders).toHaveBeenCalled()
      expect(messageRenders).toHaveBeenCalledWith('orca:opener')
      expect(messageRenders).toHaveBeenCalledWith('history:1')
      expect(timestampReads).toBeGreaterThanOrEqual(rowCount)

      const sequence = rowCount + 2
      const deliverBatch = async (action: StructuredAgentSessionAction) => {
        if (action.type !== 'event') {
          throw new Error('Expected a subscription event')
        }
        await act(async () => {
          receive(action.event)
          await vi.advanceTimersByTimeAsync(16)
        })
      }
      rowReads = timestampReads = sessionRenders = 0
      viewRenders.mockClear()
      placement.mockClear()
      listRenders.mockClear()
      messageRenders.mockClear()
      await deliverBatch(batch(sequence, [{ ...SEND, writtenAt: 2000 }], [], latestTurn))
      expect({
        sessionRenders,
        rowReads,
        timestampReads,
        viewRenders: viewRenders.mock.calls.length,
        placementRuns: placement.mock.calls.length,
        listRenders: listRenders.mock.calls.length,
        messageRenders: messageRenders.mock.calls.length
      }).toEqual({
        sessionRenders: 0,
        rowReads: 0,
        timestampReads: 0,
        viewRenders: 0,
        placementRuns: 0,
        listRenders: 0,
        messageRenders: 0
      })
      expect(shows(mounted, 'Sending…')).toBe(false)
      expect(shows(mounted, 'Working')).toBe(true)
      const stableSending = sendingSource

      await deliverBatch(
        batch(
          sequence + 1,
          [],
          [
            {
              itemId: 'reasoning',
              revision: 0,
              sequence: sequence + 1,
              observedAt: 2500,
              body: { kind: 'message', role: 'reasoning', state: 'running', blocks: [] }
            }
          ],
          latestTurn
        )
      )
      expect(rowReads).toBeGreaterThan(0)
      expect(thinking).toBe(true)
      expect(placement).toHaveBeenCalledOnce()
      expect(placement).toHaveBeenCalledWith([['closed', expect.any(String)]])
      expect(timestampReads).toBeGreaterThanOrEqual(rowCount)
      expect(sendingSource).toBe(stableSending)

      act(() => mounted.update(createElement(Session, { hostStopping: true })))
      const retry = { ...SEND, handedOverAt: 2600 }
      activityRenders.mockClear()
      await deliverBatch(batch(sequence + 2, [retry], [], latestTurn))
      expect(sendingSource?.getId('orca:opener')).toBe(true)
      expect(activityRenders).not.toHaveBeenCalled()

      await deliverBatch(
        batch(
          sequence + 3,
          [{ ...retry, dispatchState: 'rejected', resolvedAt: 2700 }],
          [],
          latestTurn
        )
      )
      expect(sendingIds(sendingSource).length).toBe(0)
      expect(activityRenders).toHaveBeenLastCalledWith(true, false)
      expect(activityRenders).not.toHaveBeenCalledWith(true, true)

      act(() => mounted.update(createElement(Session)))
      const card: AgentSessionQueuedMessage = {
        messageId: 'held-draft',
        position: 1,
        state: 'waiting',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Steer' }] }
      }
      await deliverBatch(batch(sequence + 4, [], [], latestTurn, [card]))
      expect(sendingIds(sendingSource).length).toBe(0)
      expect(activityRenders).toHaveBeenLastCalledWith(false, false)

      activityRenders.mockClear()
      await deliverBatch(batch(sequence + 5, [], [], latestTurn, [{ ...card, steers: true }]))
      expect(activityRenders).not.toHaveBeenCalled()
      expect(sendingIds(sendingSource)).toEqual(['orca:held-draft'])

      const steer: AgentJournalSubmission = {
        ...SEND,
        clientMessageId: 'steer-attempt',
        queuedMessageId: card.messageId,
        handoverRecorded: true,
        handedOverAt: 2900
      }
      activityRenders.mockClear()
      await deliverBatch(
        batch(
          sequence + 6,
          [steer],
          [
            {
              itemId: 'orca:steer-attempt',
              revision: 0,
              sequence: sequence + 6,
              observedAt: 2900,
              body: card.body
            }
          ],
          latestTurn,
          []
        )
      )
      expect(sendingIds(sendingSource)).toEqual(['orca:steer-attempt'])
      expect(activityRenders).not.toHaveBeenCalled()

      await deliverBatch(batch(sequence + 7, [{ ...steer, writtenAt: 3000 }], [], latestTurn))
      expect(sendingIds(sendingSource).length).toBe(0)
      expect(activityRenders).toHaveBeenCalledExactlyOnceWith(false, false)
    } finally {
      act(() => mounted.unmount())
      vi.useRealTimers()
    }
  }
)

// PR #45057: streaming text used to rescan the rows that could show Sending.
it.each([
  ['web', 160],
  ['web', 1600],
  ['ios', 160],
  ['ios', 1600]
] as const)(
  'checks zero displayed memberships on a tail text update (%s, %i rows)',
  async (platform, count) => {
    const original = Platform.OS
    Platform.OS = platform
    const pending = 'orca:opener'
    const receipts = new Map()
    const source = createStructuredAgentSendingSource(
      { getSnapshot: () => receipts, subscribe: noSubscription },
      [{ clientMessageId: 'opener' }],
      []
    )
    const has = vi.spyOn(source.candidates, 'has')
    const rows: NativeChatMessage[] = Array.from({ length: count }, (_, index) => ({
      id: index === count - 1 ? pending : `row-${index}`,
      role: index === count - 1 ? 'user' : 'assistant',
      blocks: [],
      timestamp: null,
      source: 'transcript'
    }))
    const noop = () => {}
    const props: Omit<ComponentProps<typeof MobileNativeChatRowList>, 'rows'> = {
      tail: {
        listProps: { ref: noop },
        pageListProps: {
          ref: noop,
          isFollowing: () => true,
          onEndDistance: noop,
          onPlaceRestored: noop
        },
        pinToTail: noop,
        pinToTailAfterContentResize: noop,
        showJumpToTail: false,
        jumpToTail: noop,
        releaseFollow: noop,
        scrollRowToTop: noop,
        beginUserScroll: noop,
        endUserDrag: noop,
        beginMomentum: noop,
        endMomentum: noop,
        scrollMayLoadEarlier: () => false,
        recordScrollMetrics: noop,
        viewport: createMobileNativeChatTailViewport()
      },
      rowKeys: {
        scope: `membership-${platform}-${count}`,
        keyOf: (row) => row.id,
        current: (key) => key,
        placement: (key) => key
      },
      itemJump: { rowKey: rows[0]!.id, beforeScroll: noop, complete: noop },
      renderItem: () => createElement('span'),
      contentContainerStyle: {},
      header: null,
      footer: null,
      waitingRows: [],
      sending: source,
      emptyStateView: null,
      onScroll: noop,
      layoutKey: 'layout',
      hasHeader: false,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture's pinch wrapper renders its children without using the native gesture.
      pinchGesture: {} as ComponentProps<typeof MobileNativeChatRowList>['pinchGesture']
    }
    let tree: ReactTestRenderer | undefined
    try {
      await act(() => {
        tree = create(createElement(MobileNativeChatRowList, { ...props, rows }))
      })
      expect(has).toHaveBeenCalledWith(pending)
      has.mockClear()
      for (let index = 0; index < 10; index += 1) {
        const next = [
          ...rows.slice(0, -1),
          { ...rows.at(-1)!, blocks: [{ type: 'text' as const, text: `chunk-${index}` }] }
        ]
        await act(() =>
          tree!.update(createElement(MobileNativeChatRowList, { ...props, rows: next }))
        )
      }
      expect(has.mock.calls).toHaveLength(0)
      const footer = { item: rows.at(-1)!, index: count - 1 }
      await act(() =>
        tree!.update(
          createElement(MobileNativeChatRowList, {
            ...props,
            rows: rows.slice(0, -1),
            waitingRows: [footer]
          })
        )
      )
      expect(has).toHaveBeenCalledWith(pending)
    } finally {
      await act(() => tree?.unmount())
      Platform.OS = original
    }
  }
)

it.each(['list', 'footer'])(
  'draws a steer added during a page hold in the %s',
  async (location) => {
    vi.useFakeTimers()
    const prior: NativeChatMessage = {
      id: 'old-row',
      role: 'assistant',
      blocks: [],
      timestamp: 1000,
      source: 'transcript'
    }
    const steer: NativeChatMessage = { ...prior, role: 'user', id: 'orca:steer' }
    const row = (item: NativeChatMessage) =>
      createElement(MobileNativeChatMessageTime, {
        timestamp: 1000,
        fontScale: 1,
        submissionItemId: item.id
      })
    const working = createElement(
      StructuredAgentWorkingGate,
      null,
      createElement('span', null, 'Working')
    )
    const noop = () => {}
    const viewport = {
      addEventListener: noop,
      removeEventListener: noop,
      scrollTop: -20,
      scrollHeight: 1000,
      clientHeight: 640,
      getBoundingClientRect: () => ({ top: 0, bottom: 640 }),
      querySelector: () => null
    }
    const props: ComponentProps<typeof MobileNativeChatPageList> = {
      ref: noop,
      isFollowing: () => false,
      onEndDistance: noop,
      onPlaceRestored: noop,
      rows: [prior],
      rowIds: [prior.id],
      waitingIds: [],
      rowKeys: {
        scope: location,
        keyOf: (message) => message.id,
        current: (key) => key,
        placement: (key) => key
      },
      renderItem: ({ item }) => row(item),
      layoutKey: 'test',
      contentContainerStyle: {},
      header: null,
      footer: working,
      emptyStateView: null,
      onScroll: noop
    }
    let tree!: ReactTestRenderer
    let receipts = new Map<string, number>()
    const listeners = new Set<() => void>()
    const sending = createStructuredAgentSendingSource(
      {
        getSnapshot: () => receipts,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        }
      },
      [{ clientMessageId: 'steer' }],
      []
    )
    try {
      await act(() => {
        tree = create(createElement(MobileNativeChatPageList, props), {
          createNodeMock: (node) =>
            node.props.onScroll
              ? {
                  getScrollableNode: () => viewport,
                  getInnerViewNode: () => null
                }
              : null
        })
      })
      expect(shows(tree, 'Working')).toBe(true)
      const scroll = tree.root.findAllByType('div').find((node) => node.props.onScroll)!
      await act(() => scroll.props.onScroll({ nativeEvent: {} }))
      const next =
        location === 'list'
          ? { ...props, sending, rows: [prior, steer], rowIds: [prior.id, steer.id] }
          : {
              ...props,
              sending,
              waitingIds: [steer.id],
              footer: createElement('div', null, working, row(steer))
            }
      await act(() => tree.update(createElement(MobileNativeChatPageList, next)))
      expect(shows(tree, 'Sending…')).toBe(true)
      expect(shows(tree, 'Working')).toBe(false)

      await act(() => scroll.props.onScroll({ nativeEvent: {} }))
      const updateTail = (text: string) =>
        act(() =>
          tree.update(
            createElement(MobileNativeChatPageList, {
              ...next,
              rows: next.rows.map((item) =>
                item === prior ? { ...item, blocks: [{ type: 'text', text }] } : item
              ),
              footer: createElement('div', null, next.footer, createElement('span', null, text))
            })
          )
        )
      await updateTail('new tail')
      const membershipCheck = vi.spyOn(sending.candidates, 'has')
      await updateTail('live tail')
      expect(membershipCheck).not.toHaveBeenCalled()
      expect(shows(tree, 'live tail')).toBe(false)
      expect(shows(tree, 'Sending…')).toBe(true)
      expect(shows(tree, 'Working')).toBe(false)

      await act(() => {
        receipts = new Map([['steer', 1100]])
        listeners.forEach((listener) => listener())
      })
      expect(shows(tree, 'Sending…')).toBe(false)
      expect(shows(tree, 'Working')).toBe(true)
      await act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(shows(tree, 'live tail')).toBe(true)
    } finally {
      await act(() => tree?.unmount())
      vi.useRealTimers()
    }
  }
)

it('keeps an idle phone send pending through admission, handover and receipt', async () => {
  const started = reduceStructuredAgentSession(
    EMPTY_STRUCTURED_AGENT_SESSION,
    {
      type: 'history-page',
      page: { ...page([], []), queuedMessages: [] }
    },
    1000
  )
  const body = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Idle send' }]
  } satisfies Extract<AgentJournalRenderItem['body'], { kind: 'message' }>
  const message = { itemId: 'orca:opener', sequence: 2, revision: 0, observedAt: 1200, body }
  const admitted = { ...SEND, handoverRecorded: true as const, handedOverAt: undefined }
  const saved = reduceStructuredAgentSession(started, batch(2, [admitted], [message]), 1200)
  const handedOver = reduceStructuredAgentSession(saved, batch(3, [SEND]), 1400)
  const received = reduceStructuredAgentSession(
    handedOver,
    batch(4, [{ ...SEND, writtenAt: 1500 }]),
    1500
  )
  let accept!: ReturnType<typeof useMobileStructuredSends>['accept']
  function Idle({ state }: { state: typeof started }) {
    const sends = useMobileStructuredSends({
      sessionKey: 'idle',
      cursor: state.cursor,
      submissions: state.submissions,
      queuedMessages: state.queuedMessages,
      onSendError: () => {}
    })
    accept = sends.accept
    const { messages, sending } = useMobileStructuredTranscript(
      {
        agent: 'claude',
        sessionKey: 'idle',
        turnId: null,
        optimistic: sends.optimistic,
        read: {
          state,
          submissionReceipts: { getSnapshot: () => state.writtenAtById, subscribe: noSubscription }
        }
      },
      false
    )
    return createElement(MobileNativeChatPageList, {
      ref: () => {},
      isFollowing: () => true,
      onEndDistance: () => {},
      onPlaceRestored: () => {},
      rows: messages,
      rowIds: messages.map(({ id }) => id),
      waitingIds: [],
      rowKeys: {
        scope: 'idle',
        keyOf: (row) => row.id,
        current: (key) => key,
        placement: (key) => key
      },
      header: null,
      footer: null,
      emptyStateView: null,
      layoutKey: 'test',
      contentContainerStyle: {},
      onScroll: () => {},
      sending,
      renderItem: ({ item }) =>
        createElement(MobileNativeChatMessageTime, {
          timestamp: item.timestamp,
          submissionItemId: item.id,
          fontScale: 1
        })
    })
  }
  let mounted!: ReactTestRenderer
  try {
    await act(() => {
      mounted = create(createElement(Idle, { state: started }))
    })
    await act(() => accept({ clientMessageId: 'opener', body, queuedAt: 1100 }))
    expect(shows(mounted, 'Sending…')).toBe(true)
    for (const state of [saved, handedOver, received]) {
      await act(() => mounted.update(createElement(Idle, { state })))
      expect(shows(mounted, 'Sending…')).toBe(state !== received)
    }
  } finally {
    await act(() => mounted?.unmount())
  }
})
