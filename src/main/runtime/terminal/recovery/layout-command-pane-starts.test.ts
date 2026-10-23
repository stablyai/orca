import { describe, expect, it, vi } from 'vitest'
import { runLayoutPaneStarts, stopReplacedTerminals } from './layout-command-pane-starts'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`

describe('runLayoutPaneStarts', () => {
  it('starts each named pane through the starter', async () => {
    const start = vi.fn(async () => ({ id: 'pty-1' }))
    runLayoutPaneStarts(
      { type: 'restartPane', workspace: 'wt' },
      { stopPtyIds: ['pty-old'], startPaneKeys: [PANE_KEY] },
      start
    )
    await vi.waitFor(() =>
      expect(start).toHaveBeenCalledExactlyOnceWith({
        worktreeId: 'wt',
        tabId: 'tab-1',
        leafId: LEAF
      })
    )
  })

  it('runs no start for a create, which starts through its own path', () => {
    const start = vi.fn(async () => ({ id: 'pty-1' }))
    runLayoutPaneStarts(
      { type: 'createTerminalTab', workspace: 'wt' },
      { stopPtyIds: [], startPaneKeys: [PANE_KEY] },
      start
    )
    expect(start).not.toHaveBeenCalled()
  })
})

describe('stopReplacedTerminals', () => {
  it('stops every replaced terminal', () => {
    const stop = vi.fn(() => true)
    expect(stopReplacedTerminals(['pty-a', 'pty-b'], stop)).toBe(true)
    expect(stop.mock.calls).toEqual([['pty-a'], ['pty-b']])
  })

  it('says so when a terminal would not stop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(stopReplacedTerminals(['pty-old'], () => false)).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
