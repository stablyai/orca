import { describe, expect, it } from 'vitest'
import type { RpcResponse } from './types'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { interpretAtRpcBarrier, startRpcOperation } from './rpc-operation'
import {
  rpcRefusal,
  rpcSuccess,
  terminalListAtBarrier,
  workspaceListAtBarrier,
  worktreePsProbeAtBarrier
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

function settleAfter(milliseconds: number): Promise<'still waiting'> {
  return new Promise((resolve) => setTimeout(() => resolve('still waiting'), milliseconds))
}

describe('the post-barrier combinator', () => {
  it('starts every request before anything is awaited', () => {
    const first = replying(rpcSuccess(rows))
    const second = replying(rpcSuccess({ terminals: [] }))

    startRpcOperation(first, workspaceListAtBarrier, {})
    startRpcOperation(second, terminalListAtBarrier, {})

    expect(first.sendRequest).toHaveBeenCalledTimes(1)
    expect(second.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('yields one verdict per operation, in declared order', async () => {
    const verdicts = await interpretAtRpcBarrier([
      startRpcOperation(replying(rpcSuccess(rows)), workspaceListAtBarrier, {}),
      startRpcOperation(replying(rpcSuccess({ terminals: [] })), terminalListAtBarrier, {}),
      startRpcOperation(replying(rpcSuccess(rows)), worktreePsProbeAtBarrier, {})
    ])

    expect(verdicts).toEqual([rows, { terminals: [] }, false])
  })

  // The bug class this exists to remove: whichever peer lost the race used to decide which
  // error the user saw. Here the second request fails first in time and the first one refuses
  // afterwards, and the declaration still decides.
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

  it('does not interpret until every raw request has settled', async () => {
    const refusing = replying(rpcRefusal('runtime_error', 'boom'))
    const pending = deferred<RpcResponse>()
    const stalled = new FakeSession('connected')
    stalled.sendRequest.mockReturnValue(pending.promise)

    const barrier = interpretAtRpcBarrier([
      startRpcOperation(refusing, workspaceListAtBarrier, {}),
      startRpcOperation(stalled, terminalListAtBarrier, {})
    ])
    const raced = await Promise.race([
      barrier.then(
        () => 'resolved' as const,
        () => 'rejected' as const
      ),
      settleAfter(50)
    ])
    expect(raced).toBe('still waiting')

    pending.resolve(rpcSuccess({ terminals: [] }))
    await expect(barrier).rejects.toThrow('runtime_error: boom')
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

  it('applies the policy each family declared, at the barrier', async () => {
    const verdicts = await interpretAtRpcBarrier([
      startRpcOperation(replying(rpcRefusal('runtime_error')), terminalListAtBarrier, {}),
      startRpcOperation(replying(rpcRefusal('method_not_found')), worktreePsProbeAtBarrier, {})
    ])

    expect(verdicts).toEqual([null, true])
  })
})
