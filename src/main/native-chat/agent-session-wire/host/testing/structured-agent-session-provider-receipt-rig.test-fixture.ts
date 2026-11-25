import { expect } from 'vitest'
import { deliverClaudeReplayFrame } from '../../../../claude/structured/lifecycle/claude-structured-event-delivery'
import { waitForReplay } from '../../../../claude/structured/dispatch/claude-structured-dispatch-waiters'
import { createClaudeJournalTranslator } from '../../../../claude/structured/journal/claude-structured-journal-translation'
import type { ClaudeSession } from '../../../../claude/structured/claude-structured-session-state'
import type { AgentSessionProviderReceiptFrame } from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { ProviderReceiptEmitter } from '../../publication/subscribers/agent-session-subscriber-receipts'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import type { QueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as CHAT,
  HOST_TEST_THREAD as THREAD,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data.test-fixture'

const SENT = 'ab32198a-2629-4d9d-b4f1-ece07cb227e3'
const ECHO = '5f4cc95b-5ef7-4c17-935b-5b34ebbbc78b'

export async function openReceiptStream(rig: QueuedMessageTestRig, emit?: ProviderReceiptEmitter) {
  const frames: AgentSessionProviderReceiptFrame[] = []
  const structural: AgentSessionSubscribeEvent[] = []
  const close = await rig.host.subscribe({
    id: 'receipt-stream',
    sessionId: CHAT,
    emit: (event) => void structural.push(event),
    emitProviderReceipts: (frame, signal) => {
      frames.push(frame)
      return emit?.(frame, signal)
    }
  })
  await eventually(() => expect(frames[0]?.replace).toBe(true))
  return { close, frames, structural }
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
