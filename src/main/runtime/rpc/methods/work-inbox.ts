import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { deliverWorkInboxChatAnswer } from '../../work-inbox/work-inbox-chat-delivery'
import { clampOrchestrationAskTimeoutMs } from '../../../../shared/orchestration-ask-timeout'
import {
  WorkInboxAckParams,
  WorkInboxAnswerParams,
  WorkInboxAskParams,
  WorkInboxCancelParams,
  WorkInboxListParams,
  parseWorkInboxOptionLabels,
  type WorkInboxAskResult,
  type WorkInboxItem
} from '../../../../shared/work-inbox'
import {
  WORK_INBOX_ASK_POLL_MS,
  resolveWorkInboxAsker,
  waitForWorkInboxChange,
  wakeWorkInboxWaiters,
  workInboxStoreFor
} from '../../work-inbox/work-inbox-service'

function askResult(item: WorkInboxItem, timeoutMs: number, timedOut: boolean): WorkInboxAskResult {
  const answered = item.status === 'answered' || item.status === 'delivered'
  return {
    id: item.id,
    status: item.status,
    answer: answered ? (item.answer ?? null) : null,
    timedOut,
    cancelled: item.status === 'cancelled',
    timeoutMs,
    ...(item.status === 'cancelled'
      ? {
          message:
            'The user closed the question without providing an answer. This is not approval; do not choose a suggested option.'
        }
      : {})
  }
}

/** Answers come from a person at the desktop or a paired device, never from an agent's CLI. */
function assertHumanCaller(ctx: RpcContext): void {
  const kind = ctx.caller?.kind
  if (kind !== 'desktop' && kind !== 'paired-device') {
    throw new OrchestrationError(
      'work_inbox_human_only',
      'Work Inbox answers and dismissals are accepted only from the Orca app.'
    )
  }
}

/** An agent may only wait on or acknowledge its own question. */
function assertAsker(item: WorkInboxItem, from: string | undefined): void {
  if (from !== item.agentId) {
    throw new OrchestrationError(
      'work_inbox_not_asker',
      `Work inbox item ${item.id} was asked by another agent.`
    )
  }
}

export const WORK_INBOX_METHODS = [
  defineMethod({
    name: 'workInbox.list',
    permission: 'workspace',
    params: WorkInboxListParams,
    handler: async (params, { runtime }) =>
      workInboxStoreFor(runtime.getOrchestrationDb()).list(params)
  }),
  defineMethod({
    name: 'workInbox.answer',
    permission: 'workspace',
    params: WorkInboxAnswerParams,
    handler: async (params, ctx) => {
      assertHumanCaller(ctx)
      const store = workInboxStoreFor(ctx.runtime.getOrchestrationDb())
      const result = store.answer(params, Date.now())
      if (result.status === 'ok') {
        if (!wakeWorkInboxWaiters(params.id)) {
          await deliverWorkInboxChatAnswer(store, result.item)
        }
      }
      return result
    }
  }),
  defineMethod({
    name: 'workInbox.cancel',
    permission: 'workspace',
    params: WorkInboxCancelParams,
    handler: async (params, ctx) => {
      assertHumanCaller(ctx)
      const result = workInboxStoreFor(ctx.runtime.getOrchestrationDb()).cancel(params, Date.now())
      if (result.status === 'ok') {
        wakeWorkInboxWaiters(params.id)
      }
      return result
    }
  }),
  defineMethod({
    name: 'workInbox.reopen',
    permission: 'workspace',
    params: WorkInboxCancelParams,
    handler: async (params, ctx) => {
      assertHumanCaller(ctx)
      const result = workInboxStoreFor(ctx.runtime.getOrchestrationDb()).reopen(params)
      if (result.status === 'ok') {
        wakeWorkInboxWaiters(params.id)
      }
      return result
    }
  }),
  defineMethod({
    name: 'workInbox.ack',
    permission: 'workspace',
    params: WorkInboxAckParams,
    handler: async (params, { runtime }) => {
      const store = workInboxStoreFor(runtime.getOrchestrationDb())
      const item = store.get(params.id)
      if (item) {
        assertAsker(item, params.from)
      }
      return store.acknowledge(params.id, Date.now())
    }
  }),
  defineMethod({
    name: 'workInbox.ask',
    permission: 'workspace',
    params: WorkInboxAskParams,
    handler: async (params, { runtime, signal }): Promise<WorkInboxAskResult> => {
      const store = workInboxStoreFor(runtime.getOrchestrationDb())
      const timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
      let item: WorkInboxItem | undefined
      if (params.resume) {
        item = store.get(params.resume)
        if (!item) {
          throw new OrchestrationError(
            'work_inbox_item_not_found',
            `Work inbox item ${params.resume} was not found.`
          )
        }
        assertAsker(item, params.from)
      } else {
        if (!params.from) {
          throw new InvalidArgumentError('Missing --from: run inside an Orca terminal.')
        }
        if (params.question === undefined) {
          throw new InvalidArgumentError('A new question is required.')
        }
        item = store.create({
          asker: resolveWorkInboxAsker(runtime, params.from),
          question: params.question,
          optionLabels: parseWorkInboxOptionLabels(params.options),
          allowFreeText: params.allowFreeText ?? true,
          requestId: params.requestId,
          now: Date.now()
        })
      }
      const deadline = Date.now() + timeoutMs
      while (true) {
        const current = store.get(item.id)
        if (!current) {
          throw new OrchestrationError(
            'work_inbox_item_not_found',
            `Work inbox item ${item.id} was removed while waiting.`
          )
        }
        // A quick reopen must not erase the closure observed by this waiting agent.
        if (current.cancelledAt !== item.cancelledAt && current.cancelledAt !== undefined) {
          return askResult({ ...current, status: 'cancelled', answer: undefined }, timeoutMs, false)
        }
        if (current.status !== 'open') {
          return askResult(current, timeoutMs, false)
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0 || signal?.aborted) {
          return askResult(current, timeoutMs, true)
        }
        await waitForWorkInboxChange(
          current.id,
          Math.min(remainingMs, WORK_INBOX_ASK_POLL_MS),
          signal
        )
      }
    }
  })
]
