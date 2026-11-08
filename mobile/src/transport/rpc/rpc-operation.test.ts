import { describe, expect, it } from 'vitest'

import { FakeSession } from '../connection/mobile-endpoint-supervisor-test-fakes'

import { isLogicalClientCutoverError } from '../connection/logical-client-cutover-error'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'

import { captureRpcOperationSettlement, runRpcOperation } from './rpc-operation'
import { workspaceListOrThrow } from './rpc-operation-test-families'

describe('transport rejection stays on the promise channel', () => {
  it('rejects with the original error object', async () => {
    const error = new Error('socket closed')
    const session = new FakeSession('connected')
    session.sendRequest.mockRejectedValue(error)

    await expect(runRpcOperation(session, workspaceListOrThrow, {})).rejects.toBe(error)
  })

  it('keeps a delivery-unknown mark readable through the descriptor', async () => {
    const error = markRpcDeliveryUnknown(new Error('socket closed before response'))
    const session = new FakeSession('connected')
    session.sendRequest.mockRejectedValue(error)

    const caught = await runRpcOperation(session, workspaceListOrThrow, {}).catch(
      (thrown: unknown) => thrown
    )

    expect(caught).toBe(error)
    expect(isRpcDeliveryUnknown(caught)).toBe(true)
  })

  // instanceof misses foreign bundle copies; cutover detection must also accept the exact message.
  it('keeps a cutover error from another bundle copy recognisable', async () => {
    class ForeignBundleCutoverError extends Error {}
    const error = new ForeignBundleCutoverError('RPC interrupted by connection migration')
    const session = new FakeSession('connected')
    session.sendRequest.mockRejectedValue(error)

    const caught = await runRpcOperation(session, workspaceListOrThrow, {}).catch(
      (thrown: unknown) => thrown
    )

    expect(caught).toBe(error)
    expect(isLogicalClientCutoverError(caught)).toBe(true)
  })

  it('only captures a rejection when a caller names the all-settled helper', async () => {
    const error = new Error('socket closed')
    const session = new FakeSession('connected')
    session.sendRequest.mockRejectedValue(error)

    await expect(captureRpcOperationSettlement(session, workspaceListOrThrow, {})).resolves.toEqual(
      { status: 'rejected', error }
    )
  })
})
