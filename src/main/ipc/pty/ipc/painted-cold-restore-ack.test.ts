// Painted-restore ACK releases only the terminal currently bound to the named pane in main-owned layout.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaintedRestoreAck } from '../../../../shared/painted-restore-ack'

const ackColdRestore = vi.fn()
vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: () => ({ ackColdRestore })
}))

const PANE = { worktreeId: 'repo::/wt', tabId: 'tab-1', leafId: 'leaf-1' }

async function ackWithSwitch(
  on: boolean,
  args: Partial<PaintedRestoreAck>,
  boundPtyId: string | null
): Promise<void> {
  vi.resetModules()
  vi.doMock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: on }))
  const { acknowledgePaintedColdRestore } = await import('./painted-cold-restore-ack')
  acknowledgePaintedColdRestore(args, (_pane, ptyId) => ptyId === boundPtyId)
}

describe('acknowledgePaintedColdRestore', () => {
  beforeEach(() => {
    ackColdRestore.mockClear()
  })

  it('releases the copy for any painted terminal with the switch off', async () => {
    await ackWithSwitch(false, { id: 'pty-old' }, null)
    expect(ackColdRestore).toHaveBeenCalledWith('pty-old')
  })

  it('releases the copy for the pane’s current terminal in the layout-owner build', async () => {
    await ackWithSwitch(true, { id: 'pty-1', pane: PANE }, 'pty-1')
    expect(ackColdRestore).toHaveBeenCalledWith('pty-1')
  })

  it('keeps the copy when a stale view acks a terminal its pane no longer binds', async () => {
    await ackWithSwitch(true, { id: 'pty-old', pane: PANE }, 'pty-new')
    expect(ackColdRestore).not.toHaveBeenCalled()
  })

  it('keeps the copy for an ack that names no pane in the layout-owner build', async () => {
    await ackWithSwitch(true, { id: 'pty-1' }, 'pty-1')
    expect(ackColdRestore).not.toHaveBeenCalled()
  })
})
