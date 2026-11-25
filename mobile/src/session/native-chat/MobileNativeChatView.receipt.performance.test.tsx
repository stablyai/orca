import { placement, viewRenders } from './mobile-native-chat-view-receipt.test-fixture'
import { createElement, useMemo } from 'react'
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
import type { StructuredAgentSessionAction } from '../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { StructuredAgentSendingSource } from '../../../../src/shared/agent-session/view/use-structured-agent-sending'
import type { OrchestrationWorkerApprovalEntry } from '../../../../src/shared/orchestration/orchestration-crew'
import { MobileNativeChatView } from './MobileNativeChatView'
import { useMobileStructuredAgentState } from './agent-session/use-mobile-structured-agent-state'
import { useMobileStructuredTurnIndicator } from './transcript/ingestion/use-mobile-structured-turn-indicator'
import { useMobileStructuredTranscript } from './transcript/ingestion/use-mobile-structured-transcript'

vi.mock('./agent-session/structured-session-operation-id', () => ({
  structuredSessionOperationId: () => 'receipt-test'
}))

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
  latestTurn?: AgentSessionLatestTurn | null
): StructuredAgentSessionAction {
  return {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 'chat',
      latestTurn,
      actionablePromptIds: [],
      working: latestTurn != null,
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
    function Session() {
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
        hostStopping: false,
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
      await deliverBatch(batch(sequence, [{ ...SEND, writtenAt: 2000 }], [], latestTurn))
      expect({
        sessionRenders,
        rowReads,
        timestampReads,
        viewRenders: viewRenders.mock.calls.length,
        placementRuns: placement.mock.calls.length
      }).toEqual({
        sessionRenders: 0,
        rowReads: 0,
        timestampReads: 0,
        viewRenders: 0,
        placementRuns: 0
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
    } finally {
      act(() => mounted.unmount())
      vi.useRealTimers()
    }
  }
)
