import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { deliverClaudeReplayFrame } from '../../../../claude/structured/lifecycle/claude-structured-event-delivery'
import { waitForReplay } from '../../../../claude/structured/dispatch/claude-structured-dispatch-waiters'
import { createClaudeJournalTranslator } from '../../../../claude/structured/journal/claude-structured-journal-translation'
import type { ClaudeSession } from '../../../../claude/structured/claude-structured-session-state'
import type {
  ProviderReceiptRead,
  ProviderReceiptReply
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import { ProviderReceiptReaders } from '../../publication/receipts/provider-receipt-readers'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import type { QueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as CHAT,
  HOST_TEST_THREAD as THREAD,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data.test-fixture'

const SENT = 'ab32198a-2629-4d9d-b4f1-ece07cb227e3'
const ECHO = '5f4cc95b-5ef7-4c17-935b-5b34ebbbc78b'

export function receiptDestination() {
  const transport = new AbortController()
  const document = new AbortController()
  return {
    transport,
    document,
    endpoint: { transport: transport.signal, document: document.signal }
  }
}

export async function openReceiptStream(
  rig: QueuedMessageTestRig,
  options: { paused?: boolean; subscription?: string } = {}
) {
  const source = rig.host.providerReceipts
  const readers = new ProviderReceiptReaders(() => 'test-runtime')
  const { endpoint, transport } = receiptDestination()
  const subscription = options.subscription ?? randomUUID()
  const identity = { id: randomUUID(), generation: 1 }
  const frames: (ProviderReceiptReply & {
    updates: { clientMessageId: string; observedAt: number | null }[]
    replace: boolean
    subscription: string
  })[] = []
  const structural: AgentSessionSubscribeEvent[] = []
  const unsubscribe = await rig.host.subscribe({
    id: subscription,
    sessionId: CHAT,
    emit: (event) => void structural.push(event),
    attachProviderReceipts: (cursor) =>
      readers.attach(endpoint, identity, source, { sessionId: CHAT, subscription }, cursor)
  })
  let closed = false
  const read = async (params?: Partial<ProviderReceiptRead>) => {
    const reply = await readers.read(
      endpoint,
      {
        reader: identity,
        hostIncarnation: frames.at(-1)?.hostIncarnation ?? null,
        since: frames.at(-1)?.revision ?? null,
        ...params
      },
      source
    )
    readers.handoff(endpoint)
    const stream = reply.streams[0]
    frames.push({
      ...reply,
      updates:
        stream?.updates.map(({ clientMessageId, observedAt }) => ({
          clientMessageId,
          observedAt
        })) ?? [],
      replace: Boolean(stream?.reset),
      subscription: stream?.subscription ?? ''
    })
    return reply
  }
  const drain = async () => {
    while (!closed) {
      const reply = await read()
      if (reply.status !== 'changed') {
        readers.discard(endpoint, reply.revision)
        return
      }
    }
  }
  await read()
  if (!options.paused) {
    void drain().catch((error: unknown) => {
      if (!closed) {
        throw error
      }
    })
  }
  const close = () => {
    closed = true
    transport.abort()
    unsubscribe()
  }
  expect(frames[0]?.replace).toBe(true)
  return { close, frames, structural, read }
}

export function faultingReceiptPublisher(failure: 'throw' | 'reject') {
  const rejected = Promise.reject<void>(new Error('receipt publish rejected'))
  // Observe the rejection in the fixture too, so a regression fails by assertion on each runner.
  void rejected.catch(() => undefined)
  return {
    publish: vi.fn(() => {
      if (failure === 'throw') {
        throw new Error('receipt publish threw')
      }
      return rejected
    }),
    handled: vi.spyOn(rejected, 'catch')
  }
}

export function claudeReceiptIngress(
  rig: QueuedMessageTestRig,
  dispatch: Pick<
    Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
    'handover' | 'fence' | 'clientMessageId'
  > = rig.dispatch.mock.lastCall![0]
) {
  const sink = rig.providerEvents()
  const translator = createClaudeJournalTranslator({ sink })
  const settlements: Promise<void>[] = []
  const handover = dispatch.handover!()!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these frames read only replay state and the production translator.
  const session = {
    providerSessionId: THREAD,
    fence: dispatch.fence,
    events: sink,
    dispatchSequence: 0,
    dispatchWaiters: [],
    retiredDispatchWaiters: [],
    translator
  } as unknown as ClaudeSession
  const { waiter } = waitForReplay(
    session,
    false,
    SENT,
    'key',
    dispatch.clientMessageId,
    NOW,
    dispatch.fence,
    handover
  )
  const frame = (message: Record<string, unknown>, observedAt: number) =>
    deliverClaudeReplayFrame({
      session,
      message: { ...message, session_id: THREAD },
      sessionId: CHAT,
      now: () => observedAt,
      deliver: (run) => run(),
      isCurrent: () => true,
      emit: translator.handle,
      onReceipt: sink.recordProviderReceipt,
      onSettledLate: (outcome) =>
        void settlements.push(rig.host.settleLateDispatch({ sessionId: CHAT, ...outcome }))
    })
  return {
    translator,
    handover,
    fence: dispatch.fence,
    waiter,
    session,
    sink,
    lifecycle: (state: 'queued' | 'started', now: number, uuid = SENT) =>
      frame({ type: 'command_lifecycle', state, command_uuid: uuid }, now),
    echo: () =>
      frame(
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'work on this' }] },
          parent_tool_use_id: null,
          uuid: ECHO,
          user_message_uuid: SENT
        },
        NOW + 200
      ),
    assistant: (uuid = '619f98bd-92b5-4a2e-bcdf-27ce4346562e') =>
      frame(
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] },
          parent_tool_use_id: null,
          uuid
        },
        NOW + 300
      ),
    flush: async () => {
      await Promise.all(settlements)
      return sink.written!()
    }
  }
}
