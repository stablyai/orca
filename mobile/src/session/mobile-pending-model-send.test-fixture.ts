import { act } from 'react-test-renderer'
import { expect, it, type Mock } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import type { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import {
  structuredAgentSessionHostSupport,
  type StructuredAgentSessionHostSupport
} from './mobile-structured-agent-session-host-support'
import { AGENT_SESSION_DEFAULT_MODEL_CAPABILITY } from '../../../src/shared/agent-session-default-model'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-create-capabilities'
import { deferred, MODEL_OPTIONS, sendResult } from './structured-session-send-options.test-fixture'
import { fieldsOf, mutationOk, ok } from './use-mobile-structured-agent-session-queued.test-fixture'

export function defineMobilePendingModelSendCases({
  setAgent,
  setHostSupport,
  getHook,
  getBridge,
  sendRequest,
  mountSession,
  calls,
  captureSendOrigin,
  clearDraftForSend,
  restoreRejectedDraft
}: {
  setAgent: (agent: string) => void
  setHostSupport: (support: StructuredAgentSessionHostSupport) => void
  getHook: () => ReturnType<typeof useMobileStructuredAgentSession>
  getBridge: () => ReturnType<typeof useMobileStructuredNativeChatSendBridge>
  sendRequest: Mock<RpcClient['sendRequest']>
  mountSession: () => Promise<void>
  calls: () => Parameters<RpcClient['sendRequest']>[]
  captureSendOrigin: unknown
  clearDraftForSend: unknown
  restoreRejectedDraft: unknown
}): void {
  it.each([
    ['explicit model', true, false],
    ['Default reset', true, true],
    ['legacy explicit model', false, false],
    ['legacy Default reset', false, true]
  ] as const)(
    'rejects a send during a pending %s, then sends the accepted selection',
    async (_name, takesOptions, reset) => {
      setAgent('claude')
      setHostSupport(
        structuredAgentSessionHostSupport([
          AGENT_SESSION_DEFAULT_MODEL_CAPABILITY,
          ...(takesOptions ? [AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY] : [])
        ])
      )
      const write = deferred<RpcResponse>()
      let current = MODEL_OPTIONS.current
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.setOption') {
          return write.promise
        }
        if (method === 'agentSession.send') {
          return sendResult('accepted')
        }
        if (method === 'agentSession.options') {
          return ok({ ...MODEL_OPTIONS, current })
        }
        return ok({})
      })
      await mountSession()
      await act(async () => {})
      expect(getHook().pendingOptionId).toBeNull()
      let mutation: Promise<unknown> | undefined
      await act(async () => {
        mutation = reset
          ? getHook().optionSurface.resetOption?.('model')
          : getHook().setStructuredOption('model', 'sonnet')
        // The rendered picker has not caught up with the write's ref yet.
        expect(getHook().pendingOptionId).toBeNull()
        expect(await getBridge().sendWithOutcome('keep this draft')).toBe('rejected')
        expect(await getHook().sendWithOutcome('keep this draft')).toBe('rejected')
      })
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.setOption')
      ).toHaveLength(1)
      expect(calls()).toHaveLength(0)
      expect(getHook().session.messages).toEqual([])
      expect(captureSendOrigin).not.toHaveBeenCalled()
      expect(clearDraftForSend).not.toHaveBeenCalled()
      expect(restoreRejectedDraft).not.toHaveBeenCalled()
      await act(async () => {
        expect(await getHook().sendWithOutcome('still pending')).toBe('rejected')
      })
      await act(async () => {
        current = { model: 'sonnet', ...(reset ? { modelDefault: true } : {}) }
        write.resolve(
          mutationOk({
            key: 'model',
            value: reset ? null : 'sonnet',
            options: { model: 'sonnet' },
            ...(reset ? { modelDefault: true } : {})
          })
        )
        await mutation
        expect(await getBridge().sendWithOutcome('fresh send')).toBe('accepted')
      })
      expect(calls()).toHaveLength(1)
      if (takesOptions && !reset) {
        expect(fieldsOf(calls()[0]![1]).options).toEqual({ model: 'sonnet' })
      } else {
        expect(fieldsOf(calls()[0]![1])).not.toHaveProperty('options')
      }
      expect(getHook().session.messages).toHaveLength(1)
      expect(clearDraftForSend).toHaveBeenCalledTimes(1)
    }
  )

  it.each([false, true])(
    'releases a failed model write without changing the selection (reset %s)',
    async (reset) => {
      setAgent('claude')
      setHostSupport(
        structuredAgentSessionHostSupport([
          AGENT_SESSION_DEFAULT_MODEL_CAPABILITY,
          AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
        ])
      )
      const write = deferred<RpcResponse>()
      sendRequest.mockImplementation(async (method) =>
        method === 'agentSession.setOption'
          ? write.promise
          : method === 'agentSession.send'
            ? sendResult('accepted')
            : method === 'agentSession.options'
              ? ok(MODEL_OPTIONS)
              : method === 'agentSession.conversationCommand'
                ? mutationOk({ command: 'compact', state: 'completed' })
                : ok({})
      )
      await mountSession()
      await act(async () => {})
      await act(async () => {
        const mutation = reset
          ? getHook().optionSurface.resetOption?.('model')
          : getHook().setStructuredOption('model', 'sonnet')
        expect(await getHook().sendWithOutcome('pending')).toBe('rejected')
        expect(await getBridge().sendWithOutcome('/compact')).toBe('accepted')
        expect(getHook().isModelWritePending()).toBe(true)
        write.resolve({
          id: 'write',
          ok: false,
          error: { code: 'invalid_argument', message: 'Model unavailable' }
        })
        await mutation
        expect(await getHook().sendWithOutcome('after refusal')).toBe('accepted')
      })
      expect(calls()).toHaveLength(1)
      expect(fieldsOf(calls()[0]![1]).options).toEqual({ model: 'opus' })
    }
  )
}
