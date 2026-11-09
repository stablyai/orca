// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import {
  keybindingMatchesAction,
  type KeybindingContext,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import { dispatchGlobalPluginAliasActions } from './global-plugin-alias-dispatch'

const input = { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }

function xtermTarget(paneManagerPane: boolean): HTMLElement {
  const host = document.createElement('div')
  if (paneManagerPane) {
    host.className = 'pane'
    host.dataset.paneId = '1'
  }
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  host.append(textarea)
  return textarea
}

function chatCoverTarget(): HTMLElement {
  const host = document.createElement('div')
  host.className = 'pane'
  host.dataset.paneId = '1'
  const cover = document.createElement('div')
  cover.className = 'native-chat-pane-shell'
  const transcript = document.createElement('div')
  cover.append(transcript)
  host.append(cover)
  return transcript
}

function dispatch(
  overrides?: KeybindingOverrides,
  target = xtermTarget(true),
  context: KeybindingContext = 'terminal'
) {
  const runAction = vi.fn(() => true)
  const claimed = dispatchGlobalPluginAliasActions({
    context,
    target,
    matchShortcut: (action) =>
      keybindingMatchesAction(action, input, 'linux', overrides, { context }),
    runAction
  })
  return { runAction, claimed }
}

describe('global spatial/history ownership', () => {
  it('leaves the default spatial chord to the terminal instead of running history', () => {
    const { claimed, runAction } = dispatch()
    expect(claimed).toBe(false)
    expect(runAction).not.toHaveBeenCalled()
  })

  it('leaves the spatial chord to a pane chat cover, whose context is app', () => {
    const { claimed, runAction } = dispatch(undefined, chatCoverTarget(), 'app')
    expect(claimed).toBe(false)
    expect(runAction).not.toHaveBeenCalled()
  })

  it('also yields history rebound onto a vertical navigation chord', () => {
    const { claimed } = dispatch({
      'terminal.focusPaneLeft': [],
      'terminal.focusPaneUp': ['Ctrl+Alt+ArrowLeft']
    })
    expect(claimed).toBe(false)
  })

  it('still runs a non-history alias on the conflicting chord', () => {
    const { claimed, runAction } = dispatch({ 'sidebar.left.toggle': ['Ctrl+Alt+ArrowLeft'] })
    expect(claimed).toBe(true)
    expect(runAction).toHaveBeenCalledExactlyOnceWith('sidebar.left.toggle')
  })

  it('runs history in an xterm without panes, which has no spatial focus to yield to', () => {
    const { claimed, runAction } = dispatch(undefined, xtermTarget(false))
    expect(claimed).toBe(true)
    expect(runAction).toHaveBeenCalledExactlyOnceWith('worktree.history.back')
  })
})
