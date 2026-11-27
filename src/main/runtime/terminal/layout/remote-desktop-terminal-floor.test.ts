// A teammate viewing someone else's terminal on a shared agent sizes it as a paired desktop does: only
// typing claims the grid, the owner's typing takes it back, and the owner's grid returns when the
// viewer leaves. Watching alone never resizes it.
import { expect, it } from 'vitest'
import { RemoteDesktopTerminalFloor } from './remote-desktop-terminal-floor'

const PTY = 'pty-owner'
const OWNER = { cols: 120, rows: 40 }

/** The floor with a PTY whose grid is what its last layout set, starting at the owner's. */
function floorWithGrid() {
  const grid = new Map([[PTY, { ...OWNER }]])
  const floor = new RemoteDesktopTerminalFloor({
    isMobileDriven: () => false,
    getTerminalSize: (ptyId) => grid.get(ptyId) ?? null,
    resolveHostTarget: () => OWNER,
    hostShowsTerminals: () => true,
    applyLayout: async (ptyId, target) => {
      grid.set(ptyId, { cols: target.cols, rows: target.rows })
      return { ok: true }
    }
  })
  return { floor, size: () => grid.get(PTY) }
}

it('never resizes the owner’s terminal while a teammate only watches it', async () => {
  const { floor, size } = floorWithGrid()
  // Attaching records the viewer's geometry; a passive refresh (focus, a window resize) too.
  await floor.updateViewer(PTY, 'mate-stream', 'mate-desk', 80, 24, false)
  await floor.refreshViewer(PTY, 'mate-desk', 90, 30, false)
  expect(size()).toEqual(OWNER)
  expect(floor.isResizeDriven(PTY)).toBe(false)
})

it('gives the grid to a teammate who types, and back to the owner when they type or the teammate leaves', async () => {
  const { floor, size } = floorWithGrid()
  await floor.updateViewer(PTY, 'mate-stream', 'mate-desk', 80, 24, false)

  await floor.claimViewer(PTY, 'mate-stream')
  expect(size()).toEqual({ cols: 80, rows: 24 })
  // The owner types at the host's window: their grid comes back.
  await floor.claimHost(PTY, OWNER.cols, OWNER.rows)
  expect(size()).toEqual(OWNER)

  // The teammate types again, then leaves: the owner's grid comes back.
  await floor.claimViewer(PTY, 'mate-stream')
  expect(size()).toEqual({ cols: 80, rows: 24 })
  await floor.unregisterViewers(PTY, ['mate-stream'])
  expect(size()).toEqual(OWNER)
})
