import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { fieldsOf } from './use-mobile-structured-agent-session-queued.test-fixture'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { sendMobileStructuredAgentSessionMessage } from './mobile-structured-agent-session-send'

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

describe('a new phone send after an acknowledgement was lost', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    const saved = new Map<string, string>()
    storage.getItem.mockImplementation(async (key: string) => saved.get(key) ?? null)
    storage.setItem.mockImplementation(async (key: string, value: string) => saved.set(key, value))
    storage.removeItem.mockImplementation(async (key: string) => saved.delete(key))
  })

  it.each([false, true])(
    'delivers identical text as a new action while the old host entry stays unknown (relaunch %s)',
    async (relaunch) => {
      const ids: string[] = []
      const delivered: string[] = []
      const ledger = new Set<string>()
      const sendRequest = vi.fn<RpcClient['sendRequest']>(async (_method, params) => {
        const id = String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
        const replayed = ledger.has(id)
        ids.push(id)
        if (!replayed) {
          ledger.add(id)
          delivered.push(id)
          if (delivered.length === 1) {
            throw markRpcDeliveryUnknown(new Error('Connection closed after dispatch'))
          }
        }
        return {
          id: 'response',
          ok: true,
          result: {
            ok: true,
            replayed,
            fence: 3,
            cursor: { epoch: 'epoch', sequence: 1 },
            value: {
              clientMessageId: id,
              submission: {
                clientMessageId: id,
                fence: 3,
                payloadFingerprint: String(fieldsOf(fieldsOf(params).envelope).payloadFingerprint),
                dispatchState: id === delivered[0] ? 'unknown' : 'accepted',
                providerItemId: null,
                reason: null,
                submittedAt: Date.now(),
                resolvedAt: null
              }
            }
          }
        }
      })
      const clientFor = (): RpcClient => ({
        sendRequest,
        subscribe: vi.fn(() => vi.fn()),
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => null,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      })
      let client = clientFor()
      const onError = vi.fn()
      const message = {
        sessionId: 'session',
        sessionKey: 'remote-host:folder:session',
        callerIdentity: 'phone',
        expectedRuntimeFence: 3,
        text: 'please continue',
        attachments: [],
        onError
      }
      const send = () => sendMobileStructuredAgentSessionMessage({ ...message, client })

      expect(await send()).toBe('unknown')
      if (relaunch) {
        client = clientFor()
      }
      expect(await send()).toBe('accepted')
      expect(delivered).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
      expect(onError).not.toHaveBeenCalled()
      expect(storage.getItem).not.toHaveBeenCalled()
      expect(storage.setItem).not.toHaveBeenCalled()
    }
  )
})
