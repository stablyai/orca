import { describe, expect, it } from 'vitest'
import type { RpcResponse } from './rpc-wire-types'
import { FakeSession } from '../connection/mobile-endpoint-supervisor-test-fakes'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { interpretAtRpcBarrier, startRpcOperation } from './rpc-operation'
import {
  rpcRefusal,
  rpcSuccess,
  terminalListAtBarrier,
  workspaceListAtBarrier
} from './rpc-operation-test-families'

const rows = { worktrees: [{ id: 'w1' }] }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function replying(response: RpcResponse): FakeSession {
  const session = new FakeSession('connected')
  session.sendRequest.mockResolvedValue(response)
  return session
}

describe('the post-barrier combinator', () => {
  // Make the second request fail first to prove declaration order controls the surfaced refusal.
  it('interprets in declared order rather than completion order', async () => {
    const lateRefusal = deferred<RpcResponse>()
    const refusing = new FakeSession('connected')
    refusing.sendRequest.mockReturnValue(lateRefusal.promise)
    const dropped = new FakeSession('connected')
    dropped.sendRequest.mockRejectedValue(new Error('socket closed first'))

    const barrier = interpretAtRpcBarrier([
      startRpcOperation(refusing, workspaceListAtBarrier, {}),
      startRpcOperation(dropped, terminalListAtBarrier, {})
    ])
    lateRefusal.resolve(rpcRefusal('method_not_found', 'no such method'))

    await expect(barrier).rejects.toThrow('method_not_found: no such method')
  })

  it('keeps the middle operation error when a later one also fails', async () => {
    const barrier = interpretAtRpcBarrier([
      startRpcOperation(replying(rpcSuccess(rows)), workspaceListAtBarrier, {}),
      startRpcOperation(
        replying(rpcRefusal('conflict', 'middle refused')),
        workspaceListAtBarrier,
        {}
      ),
      startRpcOperation(
        replying(rpcRefusal('runtime_error', 'later refused')),
        workspaceListAtBarrier,
        {}
      )
    ])

    await expect(barrier).rejects.toThrow('conflict: middle refused')
  })

  it('rethrows a captured transport rejection as the original error object', async () => {
    const error = markRpcDeliveryUnknown(new Error('socket closed before response'))
    const dropped = new FakeSession('connected')
    dropped.sendRequest.mockRejectedValue(error)

    const caught = await interpretAtRpcBarrier([
      startRpcOperation(replying(rpcSuccess(rows)), workspaceListAtBarrier, {}),
      startRpcOperation(dropped, terminalListAtBarrier, {})
    ]).catch((thrown: unknown) => thrown)

    expect(caught).toBe(error)
    expect(isRpcDeliveryUnknown(caught)).toBe(true)
  })
})
