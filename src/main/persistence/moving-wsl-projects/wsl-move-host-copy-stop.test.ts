import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopWslMoveHostCopies, type WslMoveHostCopyPort } from './wsl-move-host-copy-stop'

function port(overrides: Partial<WslMoveHostCopyPort> = {}): WslMoveHostCopyPort {
  return {
    workspacesWithTerminals: vi.fn(async () => []),
    sleepWorkspace: vi.fn(async () => true),
    liveTerminals: vi.fn(async () => 0),
    wait: vi.fn(async () => {}),
    ...overrides
  }
}

describe("undo's stop of the host's copies", () => {
  // The host's agent kept running beside the one undo resumed here.
  it('sleeps every host workspace and reports stopped once none of their terminals runs', async () => {
    let checks = 0
    const host = port({ liveTerminals: vi.fn(async () => (checks++ < 4 ? 1 : 0)) })

    expect(await stopWslMoveHostCopies(['wt-a', 'wt-b'], host)).toBe('stopped')
    expect(host.sleepWorkspace).toHaveBeenCalledWith('wt-a')
    expect(host.sleepWorkspace).toHaveBeenCalledWith('wt-b')
    expect(host.wait).toHaveBeenCalled()
  })

  it('reports still running when a terminal outlives the wait, never assuming it exited', async () => {
    const host = port({ liveTerminals: vi.fn(async () => 1) })
    expect(await stopWslMoveHostCopies(['wt-a'], host, 1_000)).toBe('still-running')
  })

  it('reports unreachable when the host does not answer the sleep or the check', async () => {
    expect(await stopWslMoveHostCopies(['wt-a'], port({ sleepWorkspace: async () => null }))).toBe(
      'unreachable'
    )
    expect(await stopWslMoveHostCopies(['wt-a'], port({ liveTerminals: async () => null }))).toBe(
      'unreachable'
    )
  })

  // A host that answers for one workspace only must have none of them stopped.
  it('stops nothing when the host does not answer for every workspace up front', async () => {
    const host = port({ liveTerminals: vi.fn(async (id: string) => (id === 'wt-b' ? null : 1)) })
    expect(await stopWslMoveHostCopies(['wt-a', 'wt-b'], host)).toBe('unreachable')
    expect(host.sleepWorkspace).not.toHaveBeenCalled()
  })

  it('checks exit even when the host refused the sleep itself', async () => {
    const host = port({ sleepWorkspace: async () => false })
    expect(await stopWslMoveHostCopies(['wt-a'], host)).toBe('stopped')
  })

  // verify-15c: with the host's orcad stopped, undo of a project this computer kept no tabs for
  // asked the host nothing, released it, and left its host shell running.
  it('refuses an unanswering host even when this computer names none of its workspaces', async () => {
    const host = port({ workspacesWithTerminals: vi.fn(async () => null) })
    expect(await stopWslMoveHostCopies([], host)).toBe('unreachable')
    expect(host.sleepWorkspace).not.toHaveBeenCalled()
  })

  it("stops the host's terminals in workspaces this computer kept no tabs for", async () => {
    let checks = 0
    const host = port({
      workspacesWithTerminals: vi.fn(async () => ['wt-host-only']),
      liveTerminals: vi.fn(async () => (checks++ < 2 ? 1 : 0))
    })
    expect(await stopWslMoveHostCopies([], host)).toBe('stopped')
    expect(host.sleepWorkspace).toHaveBeenCalledWith('wt-host-only')
  })

  describe('on a slow host', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('still gives the terminals time to exit after slow sleeps used up the budget', async () => {
      vi.useFakeTimers()
      let sleptAt: number | null = null
      const workspaces = Array.from({ length: 8 }, (_, index) => `wt-${index}`)
      const host = port({
        workspacesWithTerminals: vi.fn(async () => workspaces),
        // Each sleep takes 5 s: the 30 s budget is gone before the first exit check.
        sleepWorkspace: vi.fn(async () => {
          vi.advanceTimersByTime(5_000)
          sleptAt = Date.now()
          return true
        }),
        // The terminals exit 3 s after the last sleep.
        liveTerminals: vi.fn(async () =>
          sleptAt !== null && Date.now() - sleptAt >= 3_000 ? 0 : 1
        ),
        wait: vi.fn(async (ms: number) => {
          vi.advanceTimersByTime(ms)
        })
      })
      expect(await stopWslMoveHostCopies([], host, 30_000)).toBe('stopped')
    })

    // Polls counted, not timed: a host taking 10 s per answer stretched the wait 40-fold.
    it('gives up by one wall-clock deadline however long each answer takes', async () => {
      vi.useFakeTimers()
      const started = Date.now()
      const host = port({
        workspacesWithTerminals: vi.fn(async () => ['wt-a', 'wt-b']),
        liveTerminals: vi.fn(async () => {
          vi.advanceTimersByTime(10_000)
          return 1
        }),
        wait: vi.fn(async (ms: number) => {
          vi.advanceTimersByTime(ms)
        })
      })
      expect(await stopWslMoveHostCopies([], host, 30_000)).toBe('still-running')
      // The preflight and one exit check, two workspaces each: well short of 40 polls.
      expect(vi.mocked(host.liveTerminals).mock.calls.length).toBeLessThanOrEqual(4)
      expect(Date.now() - started).toBeLessThan(60_000)
    })
  })
})
