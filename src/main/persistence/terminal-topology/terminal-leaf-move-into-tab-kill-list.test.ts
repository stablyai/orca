import { describe, expect, it, vi } from 'vitest'
import type * as SurfaceClose from '../../runtime/terminal-surface-close'
import { intoRequest, intoTabSession, localPartition } from './terminal-leaf-move-into-tab-fixture'

// Negative control: a close that would kill the moved PTY must refuse the whole move.
vi.mock('../../runtime/terminal-surface-close', async (importOriginal) => {
  const actual = await importOriginal<typeof SurfaceClose>()
  return {
    ...actual,
    closeTerminalSurfaceInWorkspaceSession: (
      ...args: Parameters<typeof actual.closeTerminalSurfaceInWorkspaceSession>
    ) => ({
      ...actual.closeTerminalSurfaceInWorkspaceSession(...args),
      ptyIdsToKill: ['pty-a', 'pty-other']
    })
  }
})

describe('the atomic source close', () => {
  it('refuses with kill_list_contains_moved_pty and writes nothing', async () => {
    const { planTerminalLeafMoveIntoTab } = await import('./terminal-leaf-move-into-tab')

    const planned = planTerminalLeafMoveIntoTab(localPartition(intoTabSession()), intoRequest)

    expect(planned.result).toEqual({ status: 'refused', reason: 'kill_list_contains_moved_pty' })
    expect(planned.sessions).toEqual([])
  })
})
