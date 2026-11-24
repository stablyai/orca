import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/workspace/identity/floating-workspace-id'
import { forwardGuestShortcutInput } from './guest-lifecycle/input/shortcuts/browser-guest-shortcut-dispatch'

function setup(worktreeId: string): {
  send: ReturnType<typeof vi.fn>
  pressChord: () => ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this branch only sends an IPC event through the resolved renderer.
  const renderer = { send } as unknown as Electron.WebContents
  return {
    send,
    pressChord: () => {
      const preventDefault = vi.fn()
      forwardGuestShortcutInput(
        {
          browserTabId: 'tab-1',
          resolveRenderer: () => renderer,
          resolveWorktreeId: () => worktreeId,
          forwardBrowserPageZoom: vi.fn()
        },
        { preventDefault, defaultPrevented: false },
        {
          code: 'Backslash',
          key: '\\',
          alt: false,
          shift: false,
          meta: process.platform === 'darwin',
          control: process.platform !== 'darwin'
        }
      )
      return preventDefault
    }
  }
}

describe('browser guest move-tab-to-split shortcut', () => {
  it('forwards the chord to the renderer from a focused guest', () => {
    const { send, pressChord } = setup('worktree-1')

    expect(pressChord()).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('ui:moveTabToSplit', {
      direction: 'right',
      sourceId: 'tab-1'
    })
  })

  it('leaves the chord alone for a floating-panel guest', () => {
    const { send, pressChord } = setup(FLOATING_TERMINAL_WORKTREE_ID)

    expect(pressChord()).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
