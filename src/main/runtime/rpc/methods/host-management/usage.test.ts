import '../../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcRequest } from '../../core'
import { RpcDispatcher } from '../../dispatcher'
import { PAIRED_DESKTOP_METHODS } from '../../server/runtime-rpc-mobile-paired-desktop-methods'
import { setUsageSnapshotStores, USAGE_METHODS } from './usage'

function dispatch(params: unknown) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: usage.snapshot never reads the runtime; the dispatcher only reads getRuntimeId.
  const runtime = { getRuntimeId: () => 'runtime-a' } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_METHODS] })
  const request: RpcRequest = { id: '1', authToken: 'token', method: 'usage.snapshot', params }
  return dispatcher.dispatch(request)
}

function store(snapshot: unknown) {
  const order: string[] = []
  return {
    order,
    whenLoaded: vi.fn(async () => {
      order.push('loaded')
    }),
    getSnapshot: vi.fn(() => {
      order.push('snapshot')
      return snapshot
    })
  }
}

describe('usage.snapshot', () => {
  it('is served to paired phones, which cannot read the desktop transcripts themselves', () => {
    expect(PAIRED_DESKTOP_METHODS).toContain('usage.snapshot')
  })

  it('fails before the desktop has handed over its stores', async () => {
    await expect(
      dispatch({ provider: 'claude', scope: 'orca', range: '30d' })
    ).resolves.toMatchObject({ ok: false })
  })

  it('waits for the store to hydrate, then returns the requested provider aggregate', async () => {
    const claude = store({ marker: 'claude' })
    const codex = store({ marker: 'codex' })
    setUsageSnapshotStores({
      claude,
      codex,
      opencode: store(null),
      muse: store(null)
    })

    const reply = await dispatch({ provider: 'codex', scope: 'all', range: '7d', limit: 5 })

    expect(reply).toMatchObject({ ok: true, result: { marker: 'codex' } })
    expect(codex.order).toEqual(['loaded', 'snapshot'])
    expect(codex.getSnapshot).toHaveBeenCalledWith('all', '7d', 5)
    expect(claude.getSnapshot).not.toHaveBeenCalled()
  })

  it('rejects an unknown provider at the boundary', async () => {
    await expect(
      dispatch({ provider: 'gemini', scope: 'orca', range: '7d' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })
})
