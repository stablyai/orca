import { describe, expect, it, vi } from 'vitest'
import { RemoteDesktopTerminalFloor } from './remote-desktop-terminal-floor'

const PTY = 'pty-inv2'
const HOST_INITIAL = { cols: 80, rows: 24 }

describe('RemoteDesktopTerminalFloor & resize-visibility (INV-2 Exclusive Grid Ownership)', () => {
  function setupHarness() {
    let currentSize = { ...HOST_INITIAL }
    const appliedLayouts: { kind: string; cols: number; rows: number }[] = []
    const providerResizes: { ptyId: string; cols: number; rows: number }[] = []

    const floor = new RemoteDesktopTerminalFloor({
      isMobileDriven: () => false,
      getTerminalSize: () => currentSize,
      resolveHostTarget: () => HOST_INITIAL,
      hostShowsTerminals: () => true,
      applyLayout: async (_ptyId, target) => {
        appliedLayouts.push({ kind: target.kind, cols: target.cols, rows: target.rows })
        currentSize = { cols: target.cols, rows: target.rows }
        return { ok: true }
      }
    })

    const mockProvider = {
      resize: vi.fn((ptyId: string, cols: number, rows: number) => {
        providerResizes.push({ ptyId, cols, rows })
        currentSize = { cols, rows }
      })
    }

    // Simulates the exact logic in src/main/ipc/pty/ipc/resize-visibility.ts:47-54
    function handlePtyResizeFromMainWindow(args: {
      id: string
      cols: number
      rows: number
    }): boolean {
      const remoteDesktopOwnsResize = floor.isResizeDriven(args.id)
      if (remoteDesktopOwnsResize) {
        floor.recordHostReclaimTarget(args.id, args.cols, args.rows)
        return false // suppressed in main process
      }
      mockProvider.resize(args.id, args.cols, args.rows)
      return true
    }

    return {
      floor,
      mockProvider,
      appliedLayouts,
      providerResizes,
      getSize: () => currentSize,
      handlePtyResizeFromMainWindow
    }
  }

  it('suppresses main window pty:resize when satellite owns the grid, saving hostReclaimTarget', async () => {
    const { floor, mockProvider, handlePtyResizeFromMainWindow, getSize } = setupHarness()

    // Host initially resizes normally
    expect(handlePtyResizeFromMainWindow({ id: PTY, cols: 90, rows: 30 })).toBe(true)
    expect(mockProvider.resize).toHaveBeenCalledWith(PTY, 90, 30)
    expect(getSize()).toEqual({ cols: 90, rows: 30 })

    // 1. Satellite connects and claims grid ownership (e.g. 140x45)
    const viewerKey = 'workspace-popout:worktree-test:1'
    await floor.updateViewer(PTY, viewerKey, 'pane-1', 140, 45, true)

    expect(floor.isResizeDriven(PTY)).toBe(true)
    expect(floor.isViewerOwner(PTY, viewerKey)).toBe(true)
    expect(getSize()).toEqual({ cols: 140, rows: 45 })

    mockProvider.resize.mockClear()

    // 2. Main window FitAddon fires pty:resize (e.g. 100x35) in the background
    const dispatched = handlePtyResizeFromMainWindow({ id: PTY, cols: 100, rows: 35 })

    // Assert INV-2: Event is silenced in main process, provider NOT resized
    expect(dispatched).toBe(false)
    expect(mockProvider.resize).not.toHaveBeenCalled()
    expect(getSize()).toEqual({ cols: 140, rows: 45 }) // PTY stays at satellite size

    // Assert hostReclaimTarget was recorded
    expect(floor.hasHostReclaimTarget(PTY)).toBe(true)

    // 3. Satellite docks/unregisters
    await floor.unregisterViewers(PTY, [viewerKey])

    // Grid ownership released; host geometry saved in hostReclaimTarget is reclaimed
    expect(floor.isResizeDriven(PTY)).toBe(false)
    expect(getSize()).toEqual({ cols: 100, rows: 35 })
  })

  it('allows main window to resize directly once satellite viewer is detached', async () => {
    const { floor, mockProvider, handlePtyResizeFromMainWindow, getSize } = setupHarness()

    const viewerKey = 'workspace-popout:worktree-test:2'
    await floor.updateViewer(PTY, viewerKey, 'pane-1', 120, 40, true)
    await floor.unregisterViewers(PTY, [viewerKey])

    mockProvider.resize.mockClear()

    // Once satellite is gone, main window resizes normally without FitAddon modification
    expect(handlePtyResizeFromMainWindow({ id: PTY, cols: 110, rows: 38 })).toBe(true)
    expect(mockProvider.resize).toHaveBeenCalledWith(PTY, 110, 38)
    expect(getSize()).toEqual({ cols: 110, rows: 38 })
  })
})
