import { describe, expect, it } from 'vitest'
import { resolveNewWorktreeFormSheetVisible } from './new-worktree-form-sheet-visibility'

describe('resolveNewWorktreeFormSheetVisible', () => {
  it('keeps the form under the source picker', () => {
    expect(resolveNewWorktreeFormSheetVisible({ modalVisible: true, drawerView: 'source' })).toBe(
      true
    )
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
