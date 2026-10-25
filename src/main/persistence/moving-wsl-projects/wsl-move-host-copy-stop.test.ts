import { describe, expect, it, vi } from 'vitest'
import { stopWslMoveHostCopies, type WslMoveHostCopyPort } from './wsl-move-host-copy-stop'

function port(overrides: Partial<WslMoveHostCopyPort> = {}): WslMoveHostCopyPort {
  return {
    sleepWorkspace: vi.fn(async () => true),
    liveTerminals: vi.fn(async () => 0),
    wait: vi.fn(async () => {}),
    ...overrides
  }
}

describe("undo's stop of the host's copies", () => {
  // awin verify-7, 6c: the host's agent kept running beside the one undo resumed here.
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

  // awin verify-9, X1: a host that answers for one workspace only must have none of them stopped.
  it('stops nothing when the host does not answer for every workspace up front', async () => {
    const host = port({ liveTerminals: vi.fn(async (id: string) => (id === 'wt-b' ? null : 1)) })
    expect(await stopWslMoveHostCopies(['wt-a', 'wt-b'], host)).toBe('unreachable')
    expect(host.sleepWorkspace).not.toHaveBeenCalled()
  })

  it('checks exit even when the host refused the sleep itself', async () => {
    const host = port({ sleepWorkspace: async () => false })
    expect(await stopWslMoveHostCopies(['wt-a'], host)).toBe('stopped')
  })
})
