import { describe, expect, it } from 'vitest'
import type { CliStatusResult } from '../../shared/runtime-types'
import { classifyDesktopOpenStatus } from './desktop-open-wait'

function status(overrides: Partial<CliStatusResult> = {}): CliStatusResult {
  return {
    app: { running: true, pid: 1, desktopWindowStatus: 'available' },
    runtime: { state: 'ready', reachable: true, runtimeId: 'runtime' },
    graph: { state: 'ready' },
    ...overrides
  }
}

describe('classifyDesktopOpenStatus', () => {
  it('returns ready when the desktop window is up and the catalog fits', () => {
    expect(classifyDesktopOpenStatus(status()).kind).toBe('ready')
  })

  it('fails with the countable hydration error once the window is up', () => {
    expect(
      classifyDesktopOpenStatus(
        status({
          runtime: {
            state: 'graph_not_ready',
            reachable: true,
            runtimeId: 'runtime',
            worktreeHydration: {
              worktreeCount: 485,
              limit: 128,
              message: 'worktree count = 485, limit = 128'
            }
          }
        })
      )
    ).toEqual({
      kind: 'capped',
      message: 'worktree count = 485, limit = 128',
      worktreeCount: 485,
      limit: 128
    })
  })

  it('does not treat a live process that stopped answering as still starting', () => {
    expect(
      classifyDesktopOpenStatus(
        status({
          app: { running: true, pid: 1 },
          runtime: { state: 'unresponsive', reachable: false, runtimeId: null },
          graph: { state: 'unavailable' }
        })
      ).kind
    ).toBe('unresponsive')
  })
})
