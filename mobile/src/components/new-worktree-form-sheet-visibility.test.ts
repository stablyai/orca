import { describe, expect, it } from 'vitest'
import { resolveNewWorktreeFormSheetVisible } from './new-worktree-form-sheet-visibility'

describe('resolveNewWorktreeFormSheetVisible', () => {
  it('keeps the form under the source picker', () => {
    expect(resolveNewWorktreeFormSheetVisible({ modalVisible: true, drawerView: 'source' })).toBe(
      true
    )
  })

  // The host Modal stays mounted across every drawer swap, so a transition that
  // renders no sheet is a transparent tap-swallowing screen with no way out if
  // the queued transition never lands.
  it('never leaves the mounted modal without a sheet during a drawer swap', () => {
    expect(
      resolveNewWorktreeFormSheetVisible({ modalVisible: true, drawerView: 'transition' })
    ).toBe(true)
  })

  it('yields the window to the content-sized pickers and the trust prompt', () => {
    for (const drawerView of ['project', 'runTarget', 'agent', 'trust']) {
      expect(resolveNewWorktreeFormSheetVisible({ modalVisible: true, drawerView })).toBe(false)
    }
  })

  it('hides everything once the modal closes', () => {
    expect(resolveNewWorktreeFormSheetVisible({ modalVisible: false, drawerView: 'form' })).toBe(
      false
    )
  })
})
