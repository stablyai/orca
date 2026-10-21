import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import {
  PaneGridRecorder,
  PANE_GRID_FLUSH_BUDGET_MS,
  PANE_GRID_RECORD_DELAY_MS
} from './pane-grid-recording'

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
  it('writes one grid per resize burst, the last one, to the pane showing the terminal', async () => {
    vi.useFakeTimers()
    const apply = vi.fn(async () => ({ ok: true }))
    const recorder = new PaneGridRecorder({ sessions: () => [sessionBinding('pty-1')], apply })

    recorder.record('pty-1', { cols: 80, rows: 24 })
    recorder.record('pty-1', { cols: 100, rows: 30 })
    await vi.advanceTimersByTimeAsync(PANE_GRID_RECORD_DELAY_MS - 1)
    expect(apply).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({
      type: 'setPaneGrid',
      workspace: WORKSPACE,
      tabId: 'tab-1',
      leafId: 'leaf-1',
      grid: { cols: 100, rows: 30 }
    })
  })

  it('writes nothing for a terminal no pane shows, or an unmeasured grid', async () => {
    vi.useFakeTimers()
    const apply = vi.fn(async () => ({ ok: true }))
    const recorder = new PaneGridRecorder({ sessions: () => [sessionBinding('pty-1')], apply })

    recorder.record('pty-other', { cols: 80, rows: 24 })
    recorder.record('pty-1', { cols: 0, rows: 0 })
    await vi.advanceTimersByTimeAsync(PANE_GRID_RECORD_DELAY_MS)

    expect(apply).not.toHaveBeenCalled()
  })

  it('writes a waiting grid at once on flush, and has nothing to flush after', async () => {
    vi.useFakeTimers()
    const apply = vi.fn(async () => ({ ok: true }))
    const recorder = new PaneGridRecorder({ sessions: () => [sessionBinding('pty-1')], apply })

    recorder.record('pty-1', { cols: 90, rows: 20 })
    await recorder.flush()

    expect(apply).toHaveBeenCalledTimes(1)
    expect(recorder.flush()).toBeNull()
    await vi.advanceTimersByTimeAsync(PANE_GRID_RECORD_DELAY_MS)
    expect(apply).toHaveBeenCalledTimes(1)
  })

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
