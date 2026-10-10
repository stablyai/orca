import { describe, expect, it } from 'vitest'
import { RemoteDesktopTerminalFloor } from './remote-desktop-terminal-floor'

const PTY = 'pty-1'
// Spawn-size host geometry the floor reclaims to when no remote viewer owns the PTY.
const HOST = { cols: 120, rows: 40 }

function createFloor() {
  let size = { ...HOST }
  const layouts: { kind: string; cols: number; rows: number }[] = []
  const floor = new RemoteDesktopTerminalFloor({
    isMobileDriven: () => false,
    getTerminalSize: () => size,
    resolveHostTarget: () => HOST,
    applyLayout: async (_ptyId, target) => {
      layouts.push({ kind: target.kind, cols: target.cols, rows: target.rows })
      size = { cols: target.cols, rows: target.rows }
      return { ok: true }
    }
  })
  return { floor, layouts, size: () => size }
}

describe('remote desktop floor across a client reconnect', () => {
  it('hands ownership to the same client stream when its stale stream is reaped', async () => {
    const { floor, layouts, size } = createFloor()
    await floor.updateViewer(PTY, 'multiplex:old:1', 'pane-A', 159, 61)
    // The reconnect stream registers without claiming before the heartbeat reaps the old socket.
    await floor.updateViewer(PTY, 'multiplex:new:1', 'pane-A', 159, 61, false)
    layouts.splice(0)

    await floor.unregisterViewers(PTY, ['multiplex:old:1'])

    expect(size()).toEqual({ cols: 159, rows: 61 })
    expect(layouts.every((layout) => layout.kind === 'remote-desktop')).toBe(true)
    expect(floor.isViewerOwner(PTY, 'multiplex:new:1')).toBe(true)
    expect(floor.getFitHold(PTY, 'multiplex:new:1').mode).toBe('desktop-fit')
  })

  it('prefers the owner replacement over an older active peer', async () => {
    const { floor, size } = createFloor()
    await floor.updateViewer(PTY, 'multiplex:peer:1', 'pane-B', 80, 24)
    await floor.updateViewer(PTY, 'multiplex:old:1', 'pane-A', 159, 61)
    await floor.updateViewer(PTY, 'multiplex:new:1', 'pane-A', 159, 61, false)

    await floor.unregisterViewers(PTY, ['multiplex:old:1'])

    expect(floor.isViewerOwner(PTY, 'multiplex:new:1')).toBe(true)
    expect(size()).toEqual({ cols: 159, rows: 61 })
  })

  it('lets the reaped owner resume when it re-registers after the host reclaimed', async () => {
    const { floor, size } = createFloor()
    await floor.updateViewer(PTY, 'multiplex:old:1', 'pane-A', 159, 61)
    // A long outage reaps the socket before the client reconnects.
    await floor.unregisterViewers(PTY, ['multiplex:old:1'])
    expect(size()).toEqual(HOST)

    await floor.updateViewer(PTY, 'multiplex:new:1', 'pane-A', 159, 61, false)

    expect(size()).toEqual({ cols: 159, rows: 61 })
    expect(floor.getFitHold(PTY, 'multiplex:new:1').mode).toBe('desktop-fit')
  })

  it('does not resume after the host claimed in between', async () => {
    const { floor, size } = createFloor()
    await floor.updateViewer(PTY, 'multiplex:old:1', 'pane-A', 159, 61)
    await floor.unregisterViewers(PTY, ['multiplex:old:1'])
    await floor.claimHost(PTY, 132, 42)

    await floor.updateViewer(PTY, 'multiplex:new:1', 'pane-A', 159, 61, false)

    expect(floor.isResizeDriven(PTY)).toBe(false)
    expect(size()).toEqual(HOST)
    expect(floor.getFitHold(PTY, 'multiplex:new:1').mode).toBe('remote-desktop-fit')
  })

  it('does not let a different client take the reaped owner seat passively', async () => {
    const { floor, size } = createFloor()
    await floor.updateViewer(PTY, 'multiplex:old:1', 'pane-A', 159, 61)
    await floor.unregisterViewers(PTY, ['multiplex:old:1'])

    await floor.updateViewer(PTY, 'multiplex:other:1', 'pane-B', 80, 24, false)

    expect(floor.isResizeDriven(PTY)).toBe(false)
    expect(size()).toEqual(HOST)
  })

  it('does not resume after another viewer claimed and released in between', async () => {
    const { floor, size } = createFloor()
    await floor.updateViewer(PTY, 'multiplex:old:1', 'pane-A', 159, 61)
    await floor.unregisterViewers(PTY, ['multiplex:old:1'])
    await floor.updateViewer(PTY, 'multiplex:other:1', 'pane-B', 80, 24)
    await floor.claimHost(PTY, 132, 42)

    await floor.updateViewer(PTY, 'multiplex:new:1', 'pane-A', 159, 61, false)

    expect(floor.isResizeDriven(PTY)).toBe(false)
    expect(size()).toEqual({ cols: 132, rows: 42 })
  })
})
