import { describe, expect, it, vi } from 'vitest'
import {
  LocalWindowTerminalGrids,
  type LocalWindowTerminalGrid
} from './local-window-terminal-grids'

const GRID = { cols: 120, rows: 40 }

function createGrids() {
  const sizes = new Map<string, LocalWindowTerminalGrid>([['pty-1', { ...GRID }]])
  const onChange = vi.fn()
  const grids = new LocalWindowTerminalGrids({
    getTerminalSize: (ptyId) => sizes.get(ptyId) ?? null,
    onChange
  })
  return { grids, sizes, onChange }
}

describe('local windows sharing a terminal grid', () => {
  it('requires visible leases in two distinct visible native windows', () => {
    const { grids, onChange } = createGrids()
    grids.setLease('pty-1', 'host-pane', 1, true)
    grids.setLease('pty-1', 'worker-pane', 2, true)
    expect(grids.getPinnedGrid('pty-1')).toBeNull()

    grids.setWindowVisible(1, true)
    expect(grids.getPinnedGrid('pty-1')).toBeNull()
    grids.setWindowVisible(2, true)
    expect(grids.getPinnedGrid('pty-1')).toEqual(GRID)
    expect([...grids.pinnedPtyIds()]).toEqual(['pty-1'])
    expect(onChange).toHaveBeenCalledExactlyOnceWith('pty-1', GRID)
  })

  it('deduplicates reconnecting streams without releasing their window pin', () => {
    const { grids, onChange } = createGrids()
    grids.setWindowVisible(1, true)
    grids.setWindowVisible(2, true)
    grids.setLease('pty-1', 'host-pane', 1, true)
    grids.setLease('pty-1', 'old-worker-stream', 2, true)
    grids.setLease('pty-1', 'new-worker-stream', 2, true)
    expect(grids.getVisibleLeases('pty-1')).toEqual([
      { windowId: 1, leaseKey: 'host-pane' },
      { windowId: 2, leaseKey: 'old-worker-stream' },
      { windowId: 2, leaseKey: 'new-worker-stream' }
    ])
    grids.removeLease('pty-1', 'old-worker-stream')
    expect(grids.getPinnedGrid('pty-1')).toEqual(GRID)
    expect(onChange).toHaveBeenCalledTimes(1)

    grids.removeLease('pty-1', 'host-pane')
    expect(grids.getPinnedGrid('pty-1')).toBeNull()
    expect([...grids.pinnedPtyIds()]).toEqual([])
    expect(onChange).toHaveBeenLastCalledWith('pty-1', null)
  })

  it('releases on navigation and treats the newly shown PTY independently', () => {
    const { grids, sizes } = createGrids()
    sizes.set('pty-2', { cols: 90, rows: 25 })
    grids.setWindowVisible(1, true)
    grids.setWindowVisible(2, true)
    grids.setLease('pty-1', 'host-pane', 1, true)
    grids.setLease('pty-1', 'worker-stream', 2, true)

    grids.setLease('pty-1', 'worker-stream', 2, false)
    grids.setLease('pty-2', 'worker-next-stream', 2, true)
    expect(grids.getPinnedGrid('pty-1')).toBeNull()
    expect(grids.getPinnedGrid('pty-2')).toBeNull()
    expect(grids.isLocalSubscription('pty-1', 'worker-stream')).toBe(true)
    grids.removeLease('pty-1', 'worker-stream')
    expect(grids.isLocalSubscription('pty-1', 'worker-stream')).toBe(false)
  })

  it('unpins hidden windows and removes every lease when a window closes', () => {
    const { grids, sizes } = createGrids()
    sizes.set('pty-2', GRID)
    grids.setWindowVisible(1, true)
    grids.setWindowVisible(2, true)
    for (const ptyId of ['pty-1', 'pty-2']) {
      grids.setLease(ptyId, 'host-pane', 1, true)
      grids.setLease(ptyId, 'worker-stream', 2, true)
    }

    grids.setWindowVisible(1, false)
    expect(grids.getPinnedGrid('pty-1')).toBeNull()
    expect(grids.getVisibleLeases('pty-1')).toEqual([{ windowId: 2, leaseKey: 'worker-stream' }])
    grids.setWindowVisible(1, true)
    expect(grids.getPinnedGrid('pty-1')).toEqual(GRID)
    grids.removeWindow(2)
    for (const ptyId of ['pty-1', 'pty-2']) {
      expect(grids.getPinnedGrid(ptyId)).toBeNull()
      expect(grids.isLocalSubscription(ptyId, 'worker-stream')).toBe(false)
      expect(grids.isLocalSubscription(ptyId, 'host-pane')).toBe(true)
    }
    grids.setLease('pty-1', 'replacement-window', 2, true)
    expect(grids.getPinnedGrid('pty-1')).toBeNull()
  })

  it('refreshes an externally changed canonical grid only when explicitly notified', () => {
    const { grids, sizes, onChange } = createGrids()
    grids.setWindowVisible(1, true)
    grids.setWindowVisible(2, true)
    grids.setLease('pty-1', 'host-pane', 1, true)
    grids.setLease('pty-1', 'worker-stream', 2, true)
    const nextGrid = { cols: 80, rows: 24 }
    sizes.set('pty-1', nextGrid)
    grids.setLease('pty-1', 'worker-stream', 2, true)
    expect(grids.getPinnedGrid('pty-1')).toEqual(GRID)

    grids.refreshPinnedGrid('pty-1')
    grids.refreshPinnedGrid('pty-1')
    expect(grids.getPinnedGrid('pty-1')).toEqual(nextGrid)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith('pty-1', nextGrid)
  })

  it('waits for a valid canonical grid and releases PTY-scoped leases on exit', () => {
    const { grids, sizes, onChange } = createGrids()
    sizes.set('pty-1', { cols: 0, rows: 0 })
    grids.setWindowVisible(1, true)
    grids.setWindowVisible(2, true)
    grids.setLease('pty-1', 'host-pane', 1, true)
    grids.setLease('pty-1', 'worker-stream', 2, true)
    expect(grids.getPinnedGrid('pty-1')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()

    sizes.set('pty-1', GRID)
    grids.refreshPinnedGrid('pty-1')
    expect(grids.getPinnedGrid('pty-1')).toEqual(GRID)
    grids.clearPty('pty-1')
    expect(grids.getPinnedGrid('pty-1')).toBeNull()
    expect(grids.isLocalSubscription('pty-1', 'worker-stream')).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith('pty-1', null)
  })
})
