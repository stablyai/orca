import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { sendMobileChatPairWrite } from './mobile-session-chat-pair-send'
import { bindMobileChatPairRoute, getMobileChatPairWrites } from './mobile-session-chat-pair-writes'

/**
 * Follows mobile-relay-rpc-session.ts: a send waits for 'connected' within its budget; a socket
 * drop closes the session, rejects written requests as delivery-unknown and publishes
 * 'disconnected' once, and a closed session never publishes again.
 */
function fakeRelaySession() {
  let state: ConnectionState = 'connected'
  let closed = false
  const listeners = new Set<(next: ConnectionState) => void>()
  const inflight: { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }[] =
    []
  const sent: unknown[] = []
  const publish = (next: ConnectionState): void => {
    if (state !== next) {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    }
  }
  const waitForConnected = (timeoutMs: number): Promise<void> =>
    state === 'connected'
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            listeners.delete(listener)
            reject(new Error('relay session connection timed out'))
          }, timeoutMs)
          const listener = (next: ConnectionState): void => {
            if (next === 'connected' || next === 'disconnected') {
              clearTimeout(timer)
              listeners.delete(listener)
              if (next === 'connected') {
                resolve()
              } else {
                reject(new Error('relay session disconnected'))
              }
            }
          }
          listeners.add(listener)
        })
  const session = {
    sent,
    async sendRequest(_method: string, params: unknown, options?: { timeoutMs?: number }) {
      await waitForConnected(options?.timeoutMs ?? 30_000)
      if (closed) {
        throw new Error('relay session not connected')
      }
      sent.push(params)
      return new Promise<RpcResponse>((resolve, reject) => inflight.push({ resolve, reject }))
    },
    replyAll(result: unknown): void {
      for (const pending of inflight.splice(0)) {
        pending.resolve({ id: 'reply', ok: true, result, _meta: { runtimeId: 'r' } })
      }
    },
    drop(): void {
      closed = true
      for (const pending of inflight.splice(0)) {
        pending.reject(markRpcDeliveryUnknown(new Error('relay socket closed')))
      }
      publish('disconnected')
    },
    subscribe: () => () => {},
    getState: () => state,
    onStateChange(listener: (next: ConnectionState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close(): void {
      if (!closed) {
        closed = true
        publish('disconnected')
      }
    }
  }
  return {
    session,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the logical client and the writer reach the session only through the members above.
    client: session as unknown as RpcClient
  }
}

describe('a chat-pair write whose relay drops after it was written (RC-F1)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resends the same sequence on the replacement relay session, not the closed one', async () => {
    const first = fakeRelaySession()
    const logical = createStableLogicalRpcClient(first.client, 'relay')
    const failures: unknown[] = []
    const unbind = bindMobileChatPairRoute('h-relay', 'w', {
      ready: () => true,
      readHostPair: () => ({ viewMode: 'terminal' }),
      send: (parentTabId, request, write) =>
        sendMobileChatPairWrite({
          client: logical,
          worktreeId: 'w',
          parentTabId,
          request,
          write,
          hostPair: () => ({ viewMode: 'terminal' })
        }),
      reportFailure: (_parentTabId, error) => failures.push(error)
    })
    getMobileChatPairWrites().submit(
      { hostId: 'h-relay', worktreeId: 'w', parentTabId: 'P' },
      { viewMode: 'chat', leafId: 'A' },
      { viewMode: 'chat', chatLeafId: 'A' }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(first.session.sent).toHaveLength(1)
    first.session.drop()
    await vi.advanceTimersByTimeAsync(1_000)

    const replacement = fakeRelaySession()
    await logical.migrateTo(replacement.client, 'relay')
    await vi.advanceTimersByTimeAsync(0)
    expect(replacement.session.sent).toEqual(first.session.sent)
    replacement.session.replyAll({ updated: true, chatView: { viewMode: 'chat', chatLeafId: 'A' } })
    await vi.advanceTimersByTimeAsync(16_000)
    expect(failures).toEqual([])
    unbind()
  })
})
