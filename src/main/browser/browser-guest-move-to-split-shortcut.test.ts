import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'

function setup(worktreeId: string): {
  send: ReturnType<typeof vi.fn>
  pressChord: () => ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  const on = vi.fn()
  setupGuestShortcutForwarding({
    browserTabId: 'tab-1',
    guest: { on, off: vi.fn() } as unknown as Electron.WebContents,
    resolveRenderer: () => ({ send }) as unknown as Electron.WebContents,
    resolveWorktreeId: () => worktreeId
  })
  const handler = on.mock.calls.find((call) => call[0] === 'before-input-event')?.[1] as (
    event: Electron.Event,
    input: Electron.Input
  ) => void
  return {
    send,
    pressChord: () => {
      const preventDefault = vi.fn()
      handler(
        { preventDefault } as unknown as Electron.Event,
        {
          type: 'keyDown',
          code: 'Backslash',
          key: '\\',
          alt: false,
          shift: false,
          meta: process.platform === 'darwin',
          control: process.platform !== 'darwin'
        } as Electron.Input
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
