import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { pendingByPaneKey } from './serializer-state'
import { seedHeadlessTerminalFromSpawnResult } from './terminal-spawn-restore'

const PANE_KEY = 'tab-1:leaf-1'

describe('seedHeadlessTerminalFromSpawnResult', () => {
  afterEach(() => {
    pendingByPaneKey.clear()
  })

  it('seeds main’s copy from a cold restore a window has declared, only when main owns the layout', () => {
    const seedHeadlessTerminal = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seed calls only seedHeadlessTerminal.
    const runtime = { seedHeadlessTerminal } as unknown as OrcaRuntimeService
    pendingByPaneKey.set(PANE_KEY, { gen: 1, ownerWebContentsId: 7 })

    seedHeadlessTerminalFromSpawnResult(
      runtime,
      { id: 'pty-1', coldRestore: { scrollback: 'history', cwd: '/w' } },
      PANE_KEY
    )

    // Main's copy is what a view repaints from later; the window holds nothing until it paints.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(seedHeadlessTerminal).toHaveBeenCalledWith('pty-1', 'history', undefined, {
        cwd: '/w',
        oscLinks: undefined,
        preferProviderIfExisting: true
      })
    } else {
      expect(seedHeadlessTerminal).not.toHaveBeenCalled()
    }
  })
})
