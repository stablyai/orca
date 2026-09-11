import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RpcResponse } from './types'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import {
  createStableLogicalRpcClient,
  isLogicalClientCutoverError
} from './stable-logical-rpc-client'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import {
  RpcIncompatibleReplyError,
  isRpcIncompatibleReplyError
} from './rpc-incompatible-reply-error'
import { captureRpcOperationSettlement, runRpcOperation } from './rpc-operation'
import {
  rpcRefusal,
  rpcSuccess,
  terminalListAtBarrier,
  terminalStreamOpener,
  workspaceListOrNull,
  workspaceListOrThrow,
  worktreePsProbe
} from './rpc-operation-test-families'

function connectedSession(response?: RpcResponse): FakeSession {
  const session = new FakeSession('connected')
  if (response) {
    session.sendRequest.mockResolvedValue(response)
  }
  return session
}

const rows = { worktrees: [{ id: 'w1' }] }

describe('request classification', () => {
  it('decodes a compatible reply, naming the variant and keeping the raw envelope', async () => {
    const response = rpcSuccess(rows)
    const settlement = await captureRpcOperationSettlement(
      connectedSession(response),
      workspaceListOrThrow,
      {}
    )

    expect(settlement).toEqual({
      status: 'fulfilled',
      outcome: {
        kind: 'decoded',
        variant: 'rows',
        value: rows,
        raw: response,
        salvage: { droppedPaths: [], droppedCount: 0 }
      }
    })
  })

  it('names the legacy variant when the host answered the older shape', async () => {
    const settlement = await captureRpcOperationSettlement(
      connectedSession(rpcSuccess([{ id: 'w1' }])),
      workspaceListOrThrow,
      {}
    )

    expect(settlement.status === 'fulfilled' && settlement.outcome.kind).toBe('decoded')
    expect(settlement.status === 'fulfilled' && settlement.outcome).toMatchObject({
      variant: 'legacy-array',
      value: [{ id: 'w1' }]
    })
  })

  it('classifies a refusal as outer-refused rather than throwing', async () => {
    const response = rpcRefusal('runtime_error', 'boom')
    const settlement = await captureRpcOperationSettlement(
      connectedSession(response),
      workspaceListOrThrow,
      {}
    )

    expect(settlement).toEqual({
      status: 'fulfilled',
      outcome: {
        kind: 'outer-refused',
        error: { code: 'runtime_error', message: 'boom' },
        raw: response
      }
    })
  })

  it('classifies a reply the reader cannot read as incompatible, with bounded issues', async () => {
    const response = rpcSuccess({ worktrees: [{ id: 7 }] })
    const settlement = await captureRpcOperationSettlement(
      connectedSession(response),
      workspaceListOrThrow,
      {}
    )

    expect(settlement.status).toBe('fulfilled')
    if (settlement.status !== 'fulfilled' || settlement.outcome.kind !== 'incompatible') {
      throw new Error('expected an incompatible outcome')
    }
    expect(settlement.outcome.raw).toBe(response)
    expect(settlement.outcome.issues.map((issue) => issue.path)).toContain('rows.worktrees.0.id')
  })

  it('treats a reply that is not an object as incompatible for the nullable family', async () => {
    const settlement = await captureRpcOperationSettlement(
      connectedSession(rpcSuccess('not an object')),
      workspaceListOrNull,
      {}
    )

    expect(settlement.status === 'fulfilled' && settlement.outcome.kind).toBe('incompatible')
  })

  it('treats a throwing reader as incompatible, never as a transport failure', async () => {
    const exploding = {
      ...workspaceListOrThrow,
      read: () => {
        throw new Error('reader exploded')
      }
    }
    const settlement = await captureRpcOperationSettlement(
      connectedSession(rpcSuccess(rows)),
      exploding,
      {}
    )

    expect(settlement.status === 'fulfilled' && settlement.outcome.kind).toBe('incompatible')
  })
})

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

  // The cutover predicate matches class or exact message because instanceof misses across
  // bundle copies; a clone from another copy must still read as a cutover through the descriptor.
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

  it('fails a Promise.all group immediately instead of waiting for a stalled peer', async () => {
    const error = new Error('socket closed')
    const failing = new FakeSession('connected')
    failing.sendRequest.mockRejectedValue(error)
    const stalled = new FakeSession('connected')
    stalled.sendRequest.mockReturnValue(new Promise<RpcResponse>(() => {}))

    const group = Promise.all([
      runRpcOperation(failing, workspaceListOrThrow, {}),
      runRpcOperation(stalled, workspaceListOrThrow, {})
    ])
    const raced = await Promise.race([
      group.then(
        () => 'resolved' as const,
        (caught: unknown) => caught
      ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 50))
    ])

    expect(raced).toBe(error)
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

describe('the send path', () => {
  it('carries the worktree.ps capability stamp, because it goes through the logical client', async () => {
    const session = connectedSession(rpcSuccess(rows))
    const logical = createStableLogicalRpcClient(session, 'lan')

    await runRpcOperation(logical, workspaceListOrThrow, { limit: 500 })

    expect(session.sendRequest).toHaveBeenCalledWith(
      'worktree.ps',
      { limit: 500, supportsWorktreeVisibilitySourceDefaults: true },
      undefined
    )
  })

  it('sends the caller params object untouched for a method with no projection', async () => {
    const session = connectedSession(rpcSuccess({ terminals: [] }))
    const logical = createStableLogicalRpcClient(session, 'lan')
    const params = { worktree: 'w1' }

    await captureRpcOperationSettlement(logical, terminalListAtBarrier, params, {
      timeoutMs: 1234
    })

    expect(session.sendRequest.mock.calls[0][0]).toBe('terminal.list')
    expect(session.sendRequest.mock.calls[0][1]).toBe(params)
    expect(session.sendRequest.mock.calls[0][2]).toEqual({ timeoutMs: 1234 })
  })
})

describe('acceptance is a property of the family', () => {
  const refusal = rpcRefusal('method_not_found', 'no such method')

  it('surfaces the refusal as a coded error for the throwing family', async () => {
    await expect(
      runRpcOperation(connectedSession(refusal), workspaceListOrThrow, {})
    ).rejects.toThrow('method_not_found: no such method')
  })

  it('answers null to the same refusal for the nullable family', async () => {
    await expect(
      runRpcOperation(connectedSession(refusal), workspaceListOrNull, {})
    ).resolves.toBeNull()
  })

  it('answers true to the same refusal for the capability probe', async () => {
    await expect(runRpcOperation(connectedSession(refusal), worktreePsProbe, {})).resolves.toBe(
      true
    )
  })

  it('keeps the probe false for another refusal code and for a success', async () => {
    await expect(
      runRpcOperation(connectedSession(rpcRefusal('runtime_error')), worktreePsProbe, {})
    ).resolves.toBe(false)
    await expect(
      runRpcOperation(connectedSession(rpcSuccess(rows)), worktreePsProbe, {})
    ).resolves.toBe(false)
  })

  it('returns the decoded value for the throwing family', async () => {
    await expect(
      runRpcOperation(connectedSession(rpcSuccess(rows)), workspaceListOrThrow, {})
    ).resolves.toEqual(rows)
  })

  it('returns the reply itself only when it opened a stream', async () => {
    const opener = rpcSuccess({ subscriptionId: 's1' }, true)
    await expect(
      runRpcOperation(connectedSession(opener), terminalStreamOpener, { terminal: 't1' })
    ).resolves.toBe(opener)
    await expect(
      runRpcOperation(
        connectedSession(rpcSuccess({ subscriptionId: 's1' })),
        terminalStreamOpener,
        {
          terminal: 't1'
        }
      )
    ).resolves.toBeNull()
    await expect(
      runRpcOperation(connectedSession(rpcRefusal('runtime_error')), terminalStreamOpener, {
        terminal: 't1'
      })
    ).resolves.toBeNull()
  })
})

describe('an incompatible reply', () => {
  const incompatible = rpcSuccess({ worktrees: [{ id: 7 }] })

  it('throws a named incompatible-reply error for the throwing family', async () => {
    const caught = await runRpcOperation(
      connectedSession(incompatible),
      workspaceListOrThrow,
      {}
    ).catch((thrown: unknown) => thrown)

    expect(caught).toBeInstanceOf(RpcIncompatibleReplyError)
    expect(isRpcIncompatibleReplyError(caught)).toBe(true)
    expect((caught as RpcIncompatibleReplyError).method).toBe('worktree.ps')
    expect((caught as RpcIncompatibleReplyError).operationName).toBe('test.workspaceListOrThrow')
    expect((caught as RpcIncompatibleReplyError).issues.length).toBeGreaterThan(0)
  })

  // A reply nobody can read says nothing about what the host did, so it must not look like
  // either of the two errors the mutation retry loops replay on.
  it('authorizes no retry', async () => {
    const caught = await runRpcOperation(
      connectedSession(incompatible),
      workspaceListOrThrow,
      {}
    ).catch((thrown: unknown) => thrown)

    expect(isRpcDeliveryUnknown(caught)).toBe(false)
    expect(isLogicalClientCutoverError(caught)).toBe(false)
  })

  it('answers null for the nullable family', async () => {
    await expect(
      runRpcOperation(connectedSession(incompatible), workspaceListOrNull, {})
    ).resolves.toBeNull()
  })
})

describe('a descriptor', () => {
  it('cannot have its policy or barrier swapped at runtime', () => {
    expect(Object.isFrozen(workspaceListOrThrow)).toBe(true)
    expect(() => {
      ;(workspaceListOrThrow as { acceptance: string }).acceptance = 'object-result-or-null'
    }).toThrow(TypeError)
    expect(() => {
      ;(workspaceListOrThrow as { barrier: string }).barrier = 'after-all-requests'
    }).toThrow(TypeError)
  })

  it('publishes the fields it consumes and the schedules it owns', () => {
    expect(workspaceListOrThrow.consumes).toEqual(['worktrees.id'])
    expect(workspaceListOrThrow.schedules).toEqual([])
    expect(Object.isFrozen(workspaceListOrThrow.consumes)).toBe(true)
  })
})

// The fence itself is checked by `tsc --noEmit` (an expect-error directive that stops catching
// an error fails the typecheck). This pins its coverage so the file cannot be quietly gutted.
describe('the compile fence', () => {
  const fenceSource = readFileSync(
    fileURLToPath(new URL('./rpc-operation-compile-fence.ts', import.meta.url)),
    'utf8'
  )
  const expectErrorDirective = `@ts-${'expect-error'}`

  it('still asserts every rejection it is meant to', () => {
    const markers = [...fenceSource.matchAll(/\/\/ FENCE: (?<name>[a-z-]+)/g)].map(
      (match) => match.groups?.name
    )

    expect(markers).toEqual([
      'variant-readers-cannot-be-empty',
      'probe-cannot-take-a-reader',
      'decoding-policy-needs-a-reader',
      'acceptance-must-be-a-named-policy',
      'object-policy-reader-sees-an-object',
      'define-rejects-a-mismatched-definition',
      'method-must-exist-in-the-catalog',
      'send-params-omit-a-defaulted-field',
      'send-params-reject-a-wrong-typed-field',
      'send-params-still-name-required-fields',
      'send-params-never-tighten-the-parsed-shape',
      'send-params-do-not-degenerate-to-unknown',
      'declared-barrier-cannot-be-moved-earlier',
      'on-settle-operation-cannot-defer-to-a-barrier',
      'params-are-fixed-by-the-method',
      'probe-verdict-is-not-a-decoded-value',
      'manual-decoding-descriptor-needs-a-reader',
      'broad-policy-still-requires-a-reader',
      'object-descriptor-needs-a-reader'
    ])
    expect(fenceSource.split(expectErrorDirective).length - 1).toBe(17)
  })
})
