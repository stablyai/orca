import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { markRpcDeliveryUnknown } from '../../../transport/rpc/rpc-delivery-ambiguity'
import { sendMobileNativeChatModelControl } from './mobile-native-chat-model-control'

function client(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

const capability = 'terminal.model-control.v1'
const status = {
  ok: true as const,
  id: 'status',
  result: { capabilities: [capability] }
}

describe('phone host model control', () => {
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  beforeEach(() => {
    sendRequest.mockReset()
  })

  it('preserves zero-effect legacy handoff and never retries uncertain control', async () => {
    for (const reply of ['legacy', 'blocked', 'lost'] as const) {
      const connection = client(sendRequest)
      sendRequest.mockImplementation(async (method, _params, options) => {
        if (method === 'status.get') {
          return status
        }
        options?.beforeSend?.()
        if (reply === 'lost') {
          throw markRpcDeliveryUnknown(new Error('connection closed'))
        }
        return {
          ok: true,
          id: 'control',
          result: {
            control:
              reply === 'legacy'
                ? { outcome: 'legacy' }
                : { outcome: 'blocked', agent: 'codex', reason: 'foreign-draft' }
          }
        }
      })
      const result = await sendMobileNativeChatModelControl({
        client: connection,
        terminal: 'handle',
        clientId: 'device',
        control: { agent: 'codex', intent: { kind: 'picker', optionId: 'model' } },
        isCurrent: () => true
      })
      expect(result).toEqual(
        reply === 'legacy'
          ? null
          : reply === 'lost'
            ? { outcome: 'unknown' }
            : { outcome: 'blocked', agent: 'codex', reason: 'foreign-draft' }
      )
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'terminal.model-control')
      ).toHaveLength(1)
      sendRequest.mockClear()
    }
  })

  it('keeps known unsent changes from clearing the model and fences a changed target before send', async () => {
    for (const targetChanges of [false, true]) {
      let current = true
      sendRequest.mockImplementation(async (method, _params, options) => {
        if (method === 'status.get') {
          return status
        }
        current = !targetChanges
        options?.beforeSend?.()
        throw new Error('Not connected')
      })
      await expect(
        sendMobileNativeChatModelControl({
          client: client(sendRequest),
          terminal: 'handle',
          clientId: 'device',
          control: { agent: 'codex', intent: { kind: 'picker', optionId: 'model' } },
          isCurrent: () => current
        })
      ).resolves.toEqual({ outcome: 'blocked', agent: 'codex', reason: 'target-unavailable' })
    }
  })
})
