import { afterEach, describe, expect, it, vi } from 'vitest'
import { switchBrowserHostClientProfile } from './browser-host-client-profile-switch'
import { BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY } from '../../../shared/browser-client-profile-switch-protocol'

afterEach(() => vi.useRealTimers())

function recoveryFixture(
  result: Promise<{ status: 'completed' } | { status: 'failed'; errorCode: string }>
) {
  const expected = {
    browserHostClientId: 'client',
    browserHostGeneration: 1,
    pageHostGeneration: 1
  }
  const replacement = { ...expected, pageHostGeneration: 2 }
  const ledger = {
    issue: vi
      .fn()
      .mockReturnValueOnce({ result })
      .mockReturnValue({ result: Promise.resolve({ status: 'completed' }) }),
    retirePage: vi.fn(),
    advancePageGeneration: vi.fn()
  }
  const grant = {
    placement: expected,
    release: vi.fn(),
    executionHostKey: 'host'
  }
  const placements = {
    getPlacement: vi.fn().mockReturnValue(expected),
    beginPageRetirement: vi.fn().mockReturnValue({}),
    completePageRetirement: vi.fn(),
    reserveNewClientPage: vi.fn().mockReturnValue({ placement: replacement }),
    commitClientPageReplacement: vi.fn().mockImplementation(() => {
      throw new Error('browser_page_placement_stale')
    }),
    cancelClientPageReservation: vi.fn()
  }
  const grants = new Map([['page', grant]])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: switchBrowserHostClientProfile calls only the ledger, placement and lease members mocked here.
  const input = {
    timeoutMs: 10,
    registry: {
      requireClientPage: vi.fn().mockReturnValue(expected),
      select: vi.fn().mockReturnValue({
        ...expected,
        hostCapabilities: [BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY],
        pageReconciliationProtocolVersion: 1
      })
    },
    state: () => ({
      commandLedger: ledger,
      lease: { authorityRuntimeId: 'runtime', authorityEpoch: 'epoch' }
    }),
    placements,
    grants
  } as unknown as Parameters<typeof switchBrowserHostClientProfile>[2]
  const authority = {
    ...expected,
    browserPageId: 'page',
    authorityRuntimeId: 'runtime',
    authorityEpoch: 'epoch'
  }
  return { input, authority, ledger, placements, grants, grant }
}

describe('profile switch failure convergence', () => {
  it('bounds a stalled result without racing a close against the pending switch', async () => {
    vi.useFakeTimers()
    const f = recoveryFixture(new Promise(() => {}))
    const rejected = expect(
      switchBrowserHostClientProfile(
        f.authority,
        { id: 'isolated', label: 'Isolated', scope: 'isolated' },
        f.input
      )
    ).rejects.toThrow('browser_host_page_creation_timeout')
    await vi.advanceTimersByTimeAsync(11)
    await rejected
    expect(f.placements.cancelClientPageReservation).not.toHaveBeenCalled()
    expect(f.placements.completePageRetirement).not.toHaveBeenCalled()
    expect(f.ledger.retirePage).not.toHaveBeenCalled()
    expect(f.ledger.issue).toHaveBeenCalledTimes(1)
    // Pending client verdict must keep the old guest from being recreated.
    expect(f.grants.has('page')).toBe(true)
    expect(f.grant.release).not.toHaveBeenCalled()
  })

  it('orders late-success cleanup behind the original result and preserves its sequence', async () => {
    vi.useFakeTimers()
    let complete!: (result: { status: 'completed' }) => void
    const f = recoveryFixture(
      new Promise((resolve) => {
        complete = resolve
      })
    )
    const rejected = expect(
      switchBrowserHostClientProfile(
        f.authority,
        { id: 'isolated', label: 'Isolated', scope: 'isolated' },
        f.input
      )
    ).rejects.toThrow('browser_host_page_creation_timeout')
    await vi.advanceTimersByTimeAsync(11)
    await rejected
    expect(f.ledger.issue).toHaveBeenCalledTimes(1)
    expect(f.ledger.advancePageGeneration).not.toHaveBeenCalled()
    complete({ status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.ledger.advancePageGeneration).toHaveBeenCalledWith('page', 1, 2)
    expect(f.ledger.issue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pageHostGeneration: 2,
        command: expect.objectContaining({ type: 'closePage' })
      })
    )
    expect(f.ledger.advancePageGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      f.ledger.issue.mock.invocationCallOrder[1]
    )
    expect(f.placements.completePageRetirement).toHaveBeenCalledOnce()
    expect(f.grants.has('page')).toBe(false)
    expect(f.grant.release).toHaveBeenCalledOnce()
  })

  it('keeps the original placement when a timed-out switch later fails on the client', async () => {
    vi.useFakeTimers()
    let settle!: (result: { status: 'failed'; errorCode: string }) => void
    const f = recoveryFixture(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    const rejected = expect(
      switchBrowserHostClientProfile(
        f.authority,
        { id: 'isolated', label: 'Isolated', scope: 'isolated' },
        f.input
      )
    ).rejects.toThrow('browser_host_page_creation_timeout')
    await vi.advanceTimersByTimeAsync(11)
    await rejected
    settle({
      status: 'failed',
      errorCode: 'browser_client_page_navigation_failed'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.ledger.issue).toHaveBeenCalledTimes(1)
    expect(f.placements.completePageRetirement).not.toHaveBeenCalled()
    expect(f.grants.has('page')).toBe(true)
    expect(f.grant.release).not.toHaveBeenCalled()
  })

  it('closes the completed replacement when the host cannot commit it', async () => {
    const f = recoveryFixture(Promise.resolve({ status: 'completed' }))
    await expect(
      switchBrowserHostClientProfile(
        f.authority,
        { id: 'isolated', label: 'Isolated', scope: 'isolated' },
        f.input
      )
    ).rejects.toThrow('browser_page_placement_stale')
    expect(f.ledger.advancePageGeneration).toHaveBeenCalledWith('page', 1, 2)
    expect(f.ledger.issue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pageHostGeneration: 2,
        command: expect.objectContaining({ type: 'closePage' })
      })
    )
    expect(f.grants.has('page')).toBe(false)
    expect(f.grant.release).toHaveBeenCalledOnce()
  })
})
