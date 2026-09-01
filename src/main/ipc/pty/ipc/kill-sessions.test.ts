import { describe, expect, it, vi } from 'vitest'
import { MAX_PTY_KILL_SESSION_REFS } from '../../../../shared/pty-kill-sessions'
import { killPtySessions } from './kill-sessions'

describe('killPtySessions input bounds', () => {
  it('returns a per-ref refusal for entries above the bulk request ceiling', async () => {
    const refs = Array.from({ length: MAX_PTY_KILL_SESSION_REFS + 1 }, (_, index) => ({
      id: `session-${index}`,
      incarnationId: `incarnation-${index}`
    }))

    const results = await killPtySessions(refs, 'orphan-cleanup', {
      listProviders: () => [],
      providerForSession: () => undefined,
      isOwned: vi.fn(() => ({ owned: false })),
      shutdown: vi.fn(async () => undefined)
    })

    expect(results).toHaveLength(refs.length)
    expect(results.at(-1)).toEqual({
      ...refs.at(-1),
      verdict: 'refused',
      reason: 'kill request exceeded the maximum batch size'
    })
  })

  it('surfaces a pending incarnation refusal instead of reporting an exit', async () => {
    const result = await killPtySessions(
      [{ id: 'session-1', incarnationId: 'stale-incarnation' }],
      'orphan-cleanup',
      {
        listProviders: () => [],
        providerForSession: () =>
          ({
            listProcesses: vi.fn(async () => []),
            supportsIncarnationFence: () => true
          }) as never,
        isOwned: vi.fn(() => ({ owned: false })),
        shutdown: vi.fn(async () => ({ fenceUnavailable: true as const }))
      }
    )

    expect(result).toEqual([
      {
        id: 'session-1',
        incarnationId: 'stale-incarnation',
        verdict: 'refused',
        reason: 'incarnation fence unavailable'
      }
    ])
  })

  it('keeps an absent root unverifiable when descendant cleanup is pending', async () => {
    const provider = { listProcesses: vi.fn(async () => []) }
    const results = await killPtySessions([{ id: 'session-1' }], 'owner-close', {
      listProviders: () => [{ provider: provider as never }],
      providerForSession: () => provider as never,
      shutdown: vi.fn(async () => ({ treeUnverified: true as const }))
    })

    expect(results).toEqual([
      {
        id: 'session-1',
        fenceUnavailable: true,
        verdict: 'unverifiable',
        treeUnverified: true,
        reason: 'descendant tree could not be verified'
      }
    ])
  })

  it('allows explicit owner-close when a capable host omits incarnation evidence', async () => {
    const provider = {
      listProcesses: vi.fn(async () => []),
      supportsIncarnationFence: vi.fn(() => true)
    }
    const shutdown = vi.fn(async () => undefined)
    const results = await killPtySessions([{ id: 'session-1' }], 'owner-close', {
      listProviders: () => [{ provider: provider as never }],
      providerForSession: () => provider as never,
      shutdown,
      supportsIncarnationFence: (target, id) =>
        target.supportsIncarnationFence?.({ sessionId: id }) ?? false
    })

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(results).toEqual([{ id: 'session-1', verdict: 'exited' }])
  })

  it('resolves incarnation-fence capability per session route', async () => {
    const provider = {
      listProcesses: vi.fn(async () => []),
      supportsIncarnationFence: vi.fn()
    }
    provider.supportsIncarnationFence.mockImplementation(
      ({ sessionId }: { sessionId?: string }) => sessionId === 'current'
    )
    const shutdown = vi.fn(async () => undefined)
    const results = await killPtySessions(
      [{ id: 'legacy' }, { id: 'current', incarnationId: 'incarnation-current' }],
      'orphan-cleanup',
      {
        listProviders: () => [{ provider: provider as never }],
        providerForSession: () => provider as never,
        isOwned: () => ({ owned: false }),
        shutdown,
        supportsIncarnationFence: (target, id) =>
          target.supportsIncarnationFence?.({ sessionId: id }) ?? false
      }
    )

    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(results).toEqual([
      {
        id: 'legacy',
        verdict: 'exited',
        fenceUnavailable: true
      },
      {
        id: 'current',
        incarnationId: 'incarnation-current',
        verdict: 'exited'
      }
    ])
    expect(provider.supportsIncarnationFence).toHaveBeenCalledWith({ sessionId: 'legacy' })
    expect(provider.supportsIncarnationFence).toHaveBeenCalledWith({ sessionId: 'current' })
  })

  it('fails closed per ref when one provider inventory is unavailable', async () => {
    const failed = {
      listProcesses: vi.fn(async () => {
        throw new Error('timeout')
      })
    }
    const healthy = { listProcesses: vi.fn(async () => []) }
    const shutdown = vi.fn(async () => undefined)
    const results = await killPtySessions([{ id: 'failed' }, { id: 'healthy' }], 'orphan-cleanup', {
      listProviders: () => [{ provider: failed as never }, { provider: healthy as never }],
      providerForSession: (id) => (id === 'failed' ? failed : healthy) as never,
      isOwned: () => ({ owned: false }),
      shutdown,
      ownershipUnavailable: (provider) => provider === (failed as never)
    })

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(results[0]).toMatchObject({ id: 'failed', verdict: 'unverifiable' })
    expect(results[1]).toMatchObject({ id: 'healthy', verdict: 'exited' })
  })

  it('keeps an absent root unverifiable when descendant cleanup was not proven', async () => {
    const provider = {
      listProcesses: vi.fn(async () => []),
      supportsIncarnationFence: vi.fn(() => false)
    }
    const results = await killPtySessions([{ id: 'session-1' }], 'orphan-cleanup', {
      listProviders: () => [{ provider: provider as never }],
      providerForSession: () => provider as never,
      isOwned: () => ({ owned: false }),
      shutdown: vi.fn(async () => ({ treeUnverified: true as const }))
    })

    expect(results).toEqual([
      {
        id: 'session-1',
        fenceUnavailable: true,
        verdict: 'unverifiable',
        reason: 'descendant tree could not be verified',
        treeUnverified: true
      }
    ])
  })
})
