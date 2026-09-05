import { describe, expect, it, vi } from 'vitest'
import { runServeUpdateCensus, type CensusCapableRuntime } from './serve-update-census'
import type { RuntimeTerminalListResult } from '../shared/runtime-types'

function makeRuntime(
  result: Partial<RuntimeTerminalListResult> | { throws: Error }
): CensusCapableRuntime {
  return {
    listTerminals: vi.fn().mockImplementation(() => {
      if ('throws' in result) {
        return Promise.reject(result.throws)
      }
      return Promise.resolve({
        terminals: [],
        totalCount: 0,
        hostScope: undefined,
        ...result
      } as RuntimeTerminalListResult)
    })
  }
}

const completeScope = { hostIds: ['local'], omittedHostIds: [] }

describe('runServeUpdateCensus', () => {
  it('passes when no terminals exist on a complete host scope', async () => {
    const runtime = makeRuntime({ hostScope: completeScope, totalCount: 0 })
    await expect(runServeUpdateCensus(runtime)).resolves.toEqual({ ok: true })
    expect(runtime.listTerminals).toHaveBeenCalledWith(undefined, 1, {
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    })
  })

  it('blocks when a listing call fails', async () => {
    const runtime = makeRuntime({ throws: new Error('rpc down') })
    await expect(runServeUpdateCensus(runtime)).resolves.toEqual({
      ok: false,
      reason: 'liveness-unavailable'
    })
  })

  it('blocks when the host scope is missing or incomplete', async () => {
    const missing = makeRuntime({ hostScope: undefined })
    await expect(runServeUpdateCensus(missing)).resolves.toEqual({
      ok: false,
      reason: 'incomplete-scope'
    })

    const partial = makeRuntime({ hostScope: { hostIds: [], omittedHostIds: [] } as never })
    await expect(runServeUpdateCensus(partial)).resolves.toEqual({
      ok: false,
      reason: 'incomplete-scope'
    })
  })

  it('blocks when terminals are live even with a complete scope', async () => {
    const runtime = makeRuntime({
      hostScope: completeScope,
      terminals: [{ id: 't1' } as never],
      totalCount: 1
    })
    await expect(runServeUpdateCensus(runtime)).resolves.toEqual({
      ok: false,
      reason: 'terminals-live'
    })
  })

  it('blocks when totalCount reports live work but the terminal list is empty', async () => {
    const runtime = makeRuntime({ hostScope: completeScope, totalCount: 3 })
    await expect(runServeUpdateCensus(runtime)).resolves.toEqual({
      ok: false,
      reason: 'terminals-live'
    })
  })
})
