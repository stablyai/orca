import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { PaneGridRecorder, PANE_GRID_FLUSH_BUDGET_MS } from './pane-grid-recording'

const WORKSPACE = 'repo-1::/repo'

function sessionBinding(ptyId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKSPACE]: [
        {
          id: 'tab-1',
          ptyId,
          worktreeId: WORKSPACE,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': ptyId }
      }
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PaneGridRecorder', () => {
  it('lets a quit go on once its budget is spent while a grid write hangs', async () => {
    vi.useFakeTimers()
    const apply = vi.fn(() => new Promise<never>(() => {}))
    const recorder = new PaneGridRecorder({ sessions: () => [sessionBinding('pty-1')], apply })
    recorder.record('pty-1', { cols: 90, rows: 20 })
    let settled = false
    void recorder.flush()?.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(PANE_GRID_FLUSH_BUDGET_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('clears its budget once the writes finish first, and survives a session read that throws', async () => {
    vi.useFakeTimers()
    const recorder = new PaneGridRecorder({
      sessions: () => [sessionBinding('pty-1')],
      apply: vi.fn(async () => ({ ok: true }))
    })
    recorder.record('pty-1', { cols: 90, rows: 20 })
    await recorder.flush()
    expect(vi.getTimerCount()).toBe(0)

    const broken = new PaneGridRecorder({
      sessions: () => {
        throw new Error('store closed')
      },
      apply: vi.fn(async () => ({ ok: true }))
    })
    broken.record('pty-1', { cols: 90, rows: 20 })
    await expect(broken.flush()).resolves.toBeUndefined()
  })
})
