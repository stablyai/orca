import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import { startRegionalRehomeWorker } from './regional-rehome-worker.js'

const candidate = {
  v: 1,
  attemptId: '11111111-1111-4111-8111-111111111111',
  userId: 'private-user',
  relayHostId: 'abcdefghijklmnop',
  sourceCellId: 'source',
  sourceCellUrl: 'https://source.example.test',
  sourceCellIncarnation: '22222222-2222-4222-8222-222222222222',
  sourceAssignmentEpoch: 7,
  sourceGeneration: 3,
  targetCellId: 'target'
}
const config = {
  role: 'director',
  regionCorrectionCohortPercent: 100,
  rehomeAudience: 'https://relay.example.test/v1/admin/host-drain',
  rehomeDirectorServiceAccount: 'director@example.test'
} as RelayConfig

function setup(fetch: typeof globalThis.fetch) {
  const selectIdleRegionalRehomeCandidates = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValue([candidate])
  const claimRegionalRehome = vi.fn()
  const recordRegionalRehomeDispatchFailure = vi.fn()
  const worker = startRegionalRehomeWorker(
    config,
    {
      selectIdleRegionalRehomeCandidates,
      claimRegionalRehome,
      recordRegionalRehomeDispatchFailure
    } as unknown as RelayAssignmentStore,
    {
      safetySnapshot: () => ({ observedAt: 100 }) as never,
      intervalMs: 60_000,
      identityToken: async () => 'private-token',
      fetch
    }
  )!
  return {
    worker,
    selectIdleRegionalRehomeCandidates,
    claimRegionalRehome,
    recordRegionalRehomeDispatchFailure
  }
}

describe('idle regional worker dispatch', () => {
  afterEach(() => vi.restoreAllMocks())
  it('sends an idle request without claiming an assignment first', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ v: 1, outcome: 'committed' })
    )
    const c = setup(fetch)
    await vi.waitFor(() => expect(c.selectIdleRegionalRehomeCandidates).toHaveBeenCalledOnce())
    await c.worker.run()
    c.worker.stop()
    expect(c.claimRegionalRehome).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://source.example.test/v1/admin/host-idle-rehome')
    const { sourceCellUrl: _, ...request } = candidate
    expect(JSON.parse(String(init?.body))).toEqual({
      ...request,
      cohortPercent: 100,
      directorSafety: { observedAt: 100 }
    })
  })
  it('progresses past busy hosts without charging a dispatch failure', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ v: 1, outcome: 'busy' }))
      .mockResolvedValueOnce(Response.json({ v: 1, outcome: 'committed' }))
    const c = setup(fetch)
    await vi.waitFor(() => expect(c.selectIdleRegionalRehomeCandidates).toHaveBeenCalledOnce())
    c.selectIdleRegionalRehomeCandidates.mockResolvedValue([
      candidate,
      {
        ...candidate,
        relayHostId: 'ponmlkjihgfedcba',
        attemptId: '33333333-3333-4333-8333-333333333333'
      }
    ])
    await c.worker.run()
    c.worker.stop()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(c.recordRegionalRehomeDispatchFailure).not.toHaveBeenCalled()
  })
  it('does not charge a lost response as a claimed migration failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('response lost')
    })
    const c = setup(fetch)
    await vi.waitFor(() => expect(c.selectIdleRegionalRehomeCandidates).toHaveBeenCalledOnce())
    await c.worker.run()
    c.worker.stop()
    expect(c.recordRegionalRehomeDispatchFailure).not.toHaveBeenCalled()
  })
})
