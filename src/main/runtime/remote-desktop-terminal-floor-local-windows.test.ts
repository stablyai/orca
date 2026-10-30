import { describe, expect, it } from 'vitest'
import { RemoteDesktopTerminalFloor } from './remote-desktop-terminal-floor'

const PTY = 'pty-1'
const HOST = { cols: 120, rows: 40 }

function createFloor() {
  let size = { ...HOST }
  let pinned = false
  let mobile = false
  const localSubscriptions = new Set(['local-worker'])
  const layouts: { kind: string; cols: number; rows: number }[] = []
  const floor = new RemoteDesktopTerminalFloor({
    isMobileDriven: () => mobile,
    getTerminalSize: () => size,
    resolveHostTarget: () => HOST,
    hostShowsTerminals: () => true,
    getLocalSharedGrid: (_ptyId, subscriptionKey) =>
      pinned && (subscriptionKey === undefined || localSubscriptions.has(subscriptionKey))
        ? HOST
        : null,
    applyLayout: async (_ptyId, target) => {
      layouts.push(target)
      size = { cols: target.cols, rows: target.rows }
      return { ok: true }
    }
  })
  return {
    floor,
    layouts,
    size: () => size,
    setPinned: (value: boolean) => {
      pinned = value
    },
    setMobile: (value: boolean) => {
      mobile = value
    }
  }
}

describe('local shared grids in the remote desktop floor', () => {
  it('accepts local input claims without changing ownership or canonical layout', async () => {
    const { floor, layouts, size, setPinned } = createFloor()
    setPinned(true)
    expect(await floor.updateViewer(PTY, 'local-worker', 'worker', 70, 22)).toBe(true)
    expect(await floor.claimViewer(PTY, 'local-worker')).toBe(true)
    expect(await floor.claimHost(PTY, 160, 50)).toBe(true)
    expect(await floor.refreshViewer(PTY, 'worker', 75, 23, true)).toBe(true)

    expect(layouts).toEqual([])
    expect(size()).toEqual(HOST)
    expect(floor.isViewerOwner(PTY, 'local-worker')).toBe(false)
    expect(floor.getOwnerSubscriptionKey(PTY)).toBeNull()
    expect(floor.isResizeDriven(PTY)).toBe(true)
    expect(floor.getFitHold(PTY, 'local-worker')).toEqual({
      mode: 'remote-desktop-fit',
      ...HOST,
      localSharedGrid: true
    })
  })

  it('retains measured local dimensions for a later unpinned claim', async () => {
    const { floor, size, setPinned } = createFloor()
    setPinned(true)
    await floor.updateViewer(PTY, 'local-worker', 'worker', 70, 22)
    await floor.refreshViewer(PTY, 'worker', 85, 28, true)
    setPinned(false)
    await floor.claimViewer(PTY, 'local-worker')

    expect(size()).toEqual({ cols: 85, rows: 28 })
    expect(floor.getFitHold(PTY, 'local-worker').mode).toBe('desktop-fit')
  })

  it('uses the pinned grid when reapplying an already owning local viewer', async () => {
    const { floor, layouts, size, setPinned } = createFloor()
    await floor.updateViewer(PTY, 'local-worker', 'worker', HOST.cols, HOST.rows)
    setPinned(true)
    layouts.splice(0)
    await floor.updateViewer(PTY, 'local-worker', 'worker', 70, 22)
    await floor.applyLayout(PTY)

    expect(layouts).toEqual([
      { kind: 'remote-desktop', ...HOST, ownerSubscriptionKey: 'local-worker' }
    ])
    expect(size()).toEqual(HOST)
  })

  it('retains host measurements through pinned layout publication for the later release', async () => {
    const { floor, size, setPinned } = createFloor()
    setPinned(true)
    await floor.claimHost(PTY, 160, 50)
    await floor.applyLayout(PTY)
    expect(size()).toEqual(HOST)
    floor.clearStaleHostReclaimTarget(PTY)
    setPinned(false)
    await floor.claimHost(PTY, 160, 50)

    expect(size()).toEqual({ cols: 160, rows: 50 })
  })

  it('leaves external desktop claims authoritative while local viewers remain pinned', async () => {
    const { floor, layouts, size, setPinned } = createFloor()
    setPinned(true)
    await floor.updateViewer(PTY, 'local-worker', 'worker', 70, 22)
    await floor.updateViewer(PTY, 'external-desktop', 'external', 90, 30)
    expect(size()).toEqual({ cols: 90, rows: 30 })
    expect(floor.getFitHold(PTY, 'external-desktop')).toEqual({
      mode: 'desktop-fit',
      cols: 90,
      rows: 30
    })
    layouts.splice(0)
    await floor.claimViewer(PTY, 'local-worker')
    await floor.claimHost(PTY, 160, 50)

    expect(layouts).toEqual([])
    expect(floor.isViewerOwner(PTY, 'external-desktop')).toBe(true)
    expect(floor.getOwnerSubscriptionKey(PTY)).toBe('external-desktop')
    expect(size()).toEqual({ cols: 90, rows: 30 })
  })

  it('does not publish a local shared hold or apply a desktop layout while mobile drives', async () => {
    const { floor, layouts, setPinned, setMobile } = createFloor()
    await floor.updateViewer(PTY, 'local-worker', 'worker', HOST.cols, HOST.rows)
    setPinned(true)
    setMobile(true)
    layouts.splice(0)
    await floor.updateViewer(PTY, 'local-worker', 'worker', 70, 22)
    await floor.applyLayout(PTY)

    expect(layouts).toEqual([])
    expect(floor.getFitHold(PTY, 'local-worker').localSharedGrid).toBeUndefined()
  })
})
