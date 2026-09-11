import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { salvagingArray } from '../../../src/shared/zod-salvage'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import { captureRpcOperationSettlement, defineRpcOperation } from './rpc-operation'
import { rpcResultVariant, rpcResultVariants } from './rpc-operation-result-reader'
import {
  WORKSPACE_ROWS_SCHEMA,
  rpcSuccess,
  workspaceRowsReader
} from './rpc-operation-test-families'

const SALVAGING_ROWS_SCHEMA = z.object({
  worktrees: salvagingArray(z.object({ id: z.string() }))
})

const salvagingReader = rpcResultVariant('rows', SALVAGING_ROWS_SCHEMA)

describe('a single-variant reader', () => {
  it('decodes a matching payload and reports nothing dropped', () => {
    expect(workspaceRowsReader({ worktrees: [{ id: 'w1' }] })).toEqual({
      compatible: true,
      variant: 'rows',
      value: { worktrees: [{ id: 'w1' }] },
      salvage: { droppedPaths: [], droppedCount: 0 }
    })
  })

  it('reports dotted issue paths for a payload it cannot read', () => {
    const result = workspaceRowsReader({ worktrees: [{ id: 1 }] })

    expect(result.compatible).toBe(false)
    if (result.compatible) {
      throw new Error('expected an incompatible read')
    }
    expect(result.issues).toEqual([{ path: 'worktrees.0.id', message: expect.any(String) }])
  })

  it('carries the salvage report when the schema drops an element', () => {
    const result = salvagingReader({ worktrees: [{ id: 'w1' }, { id: 7 }] })

    expect(result).toEqual({
      compatible: true,
      variant: 'rows',
      value: { worktrees: [{ id: 'w1' }] },
      // zod-salvage reports the path relative to the salvaging container, not the envelope.
      salvage: { droppedPaths: ['1'], droppedCount: 1 }
    })
  })

  // zod-salvage keeps its collector at module level, so a leak here would blame the next
  // reply for the previous one's drops.
  it('does not leak drop diagnostics into the next read', () => {
    salvagingReader({ worktrees: [{ id: 7 }] })

    expect(salvagingReader({ worktrees: [{ id: 'w1' }] })).toMatchObject({
      salvage: { droppedPaths: [], droppedCount: 0 }
    })
  })

  it('bounds the issues it reports and says how many it dropped', () => {
    const wide = { worktrees: Array.from({ length: 25 }, () => ({ id: 1 })) }
    const result = workspaceRowsReader(wide)

    if (result.compatible) {
      throw new Error('expected an incompatible read')
    }
    expect(result.issues).toHaveLength(21)
    expect(result.issues[20]).toEqual({ path: '', message: '5 further issues omitted' })
  })

  // The caveat that comes with zod-salvage: it wraps a synchronous parse only. An async
  // schema must read as incompatible rather than leaking a promise into the outcome.
  it('reads an async schema as incompatible instead of leaking a promise', () => {
    const asyncReader = rpcResultVariant(
      'rows',
      z.object({ id: z.string() }).refine(async () => true)
    )

    const result = asyncReader({ id: 'w1' })

    expect(result.compatible).toBe(false)
    if (result.compatible) {
      throw new Error('expected an incompatible read')
    }
    expect(result.issues[0].message).toContain('synchronous parse')
  })
})

describe('a multi-variant reader', () => {
  const reader = rpcResultVariants<'rows' | 'legacy-array', unknown>([
    workspaceRowsReader,
    rpcResultVariant('legacy-array', z.array(z.object({ id: z.string() })))
  ])

  it('takes the first declared variant that reads', () => {
    expect(reader({ worktrees: [{ id: 'w1' }] })).toMatchObject({ variant: 'rows' })
  })

  it('falls through to a later variant', () => {
    expect(reader([{ id: 'w1' }])).toMatchObject({
      variant: 'legacy-array',
      value: [{ id: 'w1' }]
    })
  })

  it('tags every variant it tried when none of them reads', () => {
    const result = reader('neither shape')

    if (result.compatible) {
      throw new Error('expected an incompatible read')
    }
    expect(result.issues.map((issue) => issue.path)).toEqual(['rows', 'legacy-array'])
  })
})

describe('salvage through a descriptor', () => {
  const salvagingList = defineRpcOperation({
    name: 'test.salvagingWorkspaceList',
    method: 'worktree.ps',
    acceptance: 'require-result-or-throw',
    barrier: 'on-settle',
    consumes: ['worktrees.id'],
    schedules: [],
    read: salvagingReader
  })

  it('reports the dropped paths on the decoded outcome', async () => {
    const session = new FakeSession('connected')
    session.sendRequest.mockResolvedValue(rpcSuccess({ worktrees: [{ id: 'w1' }, { id: 7 }] }))

    const settlement = await captureRpcOperationSettlement(session, salvagingList, {})

    expect(settlement.status === 'fulfilled' && settlement.outcome).toMatchObject({
      kind: 'decoded',
      value: { worktrees: [{ id: 'w1' }] },
      salvage: { droppedPaths: ['1'], droppedCount: 1 }
    })
  })
})

describe('the shared workspace schema', () => {
  it('is the strict shape the salvaging variant relaxes', () => {
    expect(WORKSPACE_ROWS_SCHEMA.safeParse({ worktrees: [{ id: 7 }] }).success).toBe(false)
    expect(SALVAGING_ROWS_SCHEMA.safeParse({ worktrees: [{ id: 7 }] }).success).toBe(true)
  })
})
