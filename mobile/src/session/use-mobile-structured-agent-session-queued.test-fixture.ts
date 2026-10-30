import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { createElement, Fragment, type ReactElement } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { expect, onTestFinished, vi } from 'vitest'
import * as queueReducer from '../../../src/shared/structured-agent-session-reducer'
import * as queueProjection from './mobile-structured-queued-message-cards'
import { STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS } from '../../../src/shared/structured-agent-session-coalescer'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import type { RpcResponse } from '../transport/types'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

export const SESSION_ID = 'session-1'

export const CAPABLE: StructuredAgentSessionHostSupport = {
  promptCancel: false,
  questionAnswers: false,
  queuedMessages: true,
  queuedCommands: false,
  queuedMessageEdit: true,
  statusFeed: false,
  quietRepeatedStop: false,
  sendOptions: false,
  conversationStop: false,
  permissionModes: false,
  itemDetail: false,
  phoneAttachments: false
}
export const LEGACY: StructuredAgentSessionHostSupport = {
  ...CAPABLE,
  queuedMessages: false,
  queuedMessageEdit: false
}

export function ok(result: unknown): RpcResponse {
  return { id: 'request-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

export function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {}
}

export function mutationOk(value: unknown) {
  return ok({
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value
  })
}

export function acceptedSubmission(
  clientMessageId: string,
  queuedMessageId?: string
): AgentJournalSubmission {
  return {
    clientMessageId,
    ...(queuedMessageId ? { queuedMessageId } : {}),
    fence: 3,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted',
    providerItemId: `item-${clientMessageId}`,
    reason: null,
    submittedAt: 10,
    resolvedAt: 11
  }
}

export function queuedDraft(
  overrides: Partial<AgentSessionQueuedMessage> & { messageId: string }
): AgentSessionQueuedMessage {
  return {
    position: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: `text of ${overrides.messageId}` }]
    },
    state: 'waiting',
    ...overrides
  }
}

export function snapshotEvent(input?: {
  queuedMessages?: AgentSessionQueuedMessage[] | null
  items?: AgentJournalRenderItem[]
  fence?: number
  runningTurn?: boolean
  submissions?: AgentJournalSubmission[]
}): Extract<AgentSessionSubscribeEvent, { type: 'snapshot' }> {
  const items: AgentJournalRenderItem[] =
    input?.items ??
    (input?.runningTurn
      ? [
          {
            itemId: 'turn-item-1',
            revision: 1,
            body: { kind: 'turn', turnId: 'turn-1', state: 'running' },
            sequence: 1,
            observedAt: 1
          }
        ]
      : [])
  const oldest = items[0]
  const newest = items.at(-1)
  const fence = input?.fence ?? 3
  return {
    type: 'snapshot',
    sessionId: SESSION_ID,
    fence,
    page: {
      sessionId: SESSION_ID,
      epoch: 'epoch-1',
      fence,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: input?.submissions ?? [],
      window: {
        oldest: oldest ? { epoch: 'epoch-1', sequence: oldest.sequence } : null,
        newest: newest ? { epoch: 'epoch-1', sequence: newest.sequence } : null,
        nextCursor: { epoch: 'epoch-1', sequence: oldest?.sequence ?? 0 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: newest?.sequence ?? 0 },
      hasOlder: false,
      hasNewer: false
    },
    ...(input?.queuedMessages !== undefined ? { queuedMessages: input.queuedMessages } : {})
  }
}

export function batchEvent(
  queuedMessages?: AgentSessionQueuedMessage[] | null,
  submissions: AgentJournalSubmission[] = [],
  queuePause?: AgentSessionQueuePause | null
): Extract<AgentSessionSubscribeEvent, { type: 'batch' }> {
  return {
    type: 'batch',
    sessionId: SESSION_ID,
    batch: {
      cursor: { epoch: 'epoch-1', sequence: 2 },
      items: [],
      removedItemIds: [],
      submissions
    },
    ...(queuedMessages !== undefined ? { queuedMessages } : {}),
    ...(queuePause !== undefined ? { queuePause } : {})
  }
}

export async function measurePhoneQueueConsumerFrames(input: {
  count: number
  cards: AgentSessionQueuedMessage[]
  queueRender: ReturnType<typeof vi.fn>
  parentRender: ReturnType<typeof vi.fn>
  own: (event: AgentSessionSubscribeEvent) => void
  other: (event: AgentSessionSubscribeEvent) => void
  currentCards: () => readonly unknown[] | undefined
}): Promise<void> {
  const { count, cards, queueRender, parentRender } = input
  const reduce = vi.spyOn(queueReducer, 'reduceStructuredAgentSession')
  const project = vi.spyOn(queueProjection, 'mobileQueuedMessageCards')
  await act(async () => {})
  queueRender.mockClear()
  parentRender.mockClear()
  await act(async () =>
    input.own({ ...batchEvent(), activity: { turnId: 'working', text: 'token' } })
  )
  await act(async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS + 20)
    )
  })
  expect(input.currentCards()).toHaveLength(count)
  expect(queueRender).not.toHaveBeenCalled()
  expect(parentRender.mock.calls.some(([scope]) => scope === 'host-a\0workspace-a')).toBe(true)
  expect(parentRender.mock.calls.some(([scope]) => scope === 'host-b\0workspace-b')).toBe(false)
  expect(parentRender.mock.calls.every(([scope]) => scope === 'host-a\0workspace-a')).toBe(true)
  expect(reduce).toHaveBeenCalled()
  expect(project).not.toHaveBeenCalled()
  const ownToken = {
    parents: parentRender.mock.calls.length,
    reductions: reduce.mock.calls.length,
    projections: project.mock.calls.length
  }
  parentRender.mockClear()
  reduce.mockClear()
  await act(async () =>
    input.other({ ...batchEvent(), activity: { turnId: 'working', text: 'other-token' } })
  )
  await act(async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS + 20)
    )
  })
  expect(reduce).toHaveBeenCalled()
  expect(parentRender.mock.calls.some(([scope]) => scope === 'host-b\0workspace-b')).toBe(true)
  expect(parentRender.mock.calls.some(([scope]) => scope === 'host-a\0workspace-a')).toBe(false)
  expect(parentRender.mock.calls.every(([scope]) => scope === 'host-b\0workspace-b')).toBe(true)
  expect(queueRender).not.toHaveBeenCalled()
  expect(project).not.toHaveBeenCalled()
  const otherToken = {
    parents: parentRender.mock.calls.length,
    reductions: reduce.mock.calls.length,
    projections: project.mock.calls.length
  }
  parentRender.mockClear()
  await act(async () => input.own(batchEvent(cards.slice(1))))
  await vi.waitFor(() => expect(input.currentCards()).toHaveLength(count - 1))
  expect(queueRender).toHaveBeenCalledTimes(1)
  expect(queueRender.mock.calls[0]?.[0]).toBe('host-a\0workspace-a')
  expect(project).toHaveBeenCalledTimes(1)
  expect(parentRender.mock.calls.every(([scope]) => scope === 'host-a\0workspace-a')).toBe(true)
  console.info(
    'phone-queue-consumer-work',
    JSON.stringify({
      count,
      owners: count,
      ownToken,
      otherToken,
      changedProjections: project.mock.calls.length,
      changedChildren: queueRender.mock.calls.length
    })
  )
  reduce.mockRestore()
  project.mockRestore()
}

export async function mountPhoneQueuePopulation(
  count: number,
  client: RpcClient,
  cards: AgentSessionQueuedMessage[],
  render: (id: string, client: RpcClient, scope: string) => ReactElement
) {
  const listeners = new Map<string, (value: unknown) => void>()
  const ids = [SESSION_ID, ...Array.from({ length: count - 2 }, (_, n) => `idle-${n}`)]
  let view: ReactTestRenderer | undefined
  const unmount = async () => {
    await act(async () => {
      view?.unmount()
      view = undefined
    })
  }
  onTestFinished(unmount)
  await act(async () => {
    view = create(
      createElement(
        Fragment,
        null,
        ids.map((id) =>
          render(
            id,
            {
              ...client,
              subscribe: vi.fn((_method, _params, onData) => {
                listeners.set(id, onData)
                return vi.fn()
              })
            },
            id === SESSION_ID ? 'host-b\0workspace-b' : `host-b\0${id}`
          )
        )
      )
    )
  })
  await vi.waitFor(() => expect(listeners.size).toBe(count - 1))
  await act(async () => {
    for (const [id, emit] of listeners) {
      const event = snapshotEvent({ queuedMessages: id === SESSION_ID ? cards : [] })
      emit({ ...event, sessionId: id, page: { ...event.page, sessionId: id } })
    }
  })
  return {
    other: (event: AgentSessionSubscribeEvent) => listeners.get(SESSION_ID)?.(event),
    unmount
  }
}
