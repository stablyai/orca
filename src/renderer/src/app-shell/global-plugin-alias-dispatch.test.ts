import { describe, expect, it, vi } from 'vitest'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import {
  dispatchGlobalPluginAliasActions,
  globalKeybindingSkipsWorktreeHistory
} from './global-plugin-alias-dispatch'

const input = { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }

function dispatch(
  overrides?: KeybindingOverrides,
  context: 'terminal' | 'app' = 'terminal',
  terminalShortcutPolicy: 'orca-first' | 'terminal-first' = 'orca-first'
) {
  const runAction = vi.fn(() => true)
  const claimed = dispatchGlobalPluginAliasActions({
    context,
    matchShortcut: (action) =>
      keybindingMatchesAction(action, input, 'linux', overrides, {
        context,
        terminalShortcutPolicy
      }),
    runAction
  })
  return { runAction, claimed }
}

describe('global spatial/history ownership', () => {
  it('only skips history for actual conflicts in a terminal', () => {
    expect(globalKeybindingSkipsWorktreeHistory('terminal', 'worktree.history.back', true)).toBe(
      true
    )
    expect(globalKeybindingSkipsWorktreeHistory('terminal', 'worktree.history.back', false)).toBe(
      false
    )
    expect(globalKeybindingSkipsWorktreeHistory('app', 'worktree.history.back', true)).toBe(false)
    expect(globalKeybindingSkipsWorktreeHistory('terminal', 'sidebar.left.toggle', true)).toBe(
      false
    )
    expect(dispatch().claimed).toBe(false)
    expect(dispatch().runAction).not.toHaveBeenCalled()
  })

  it.each([{ bindings: [] }, { bindings: ['Ctrl+H'] }])(
    'keeps history when directional navigation is unbound/remapped: %j',
    ({ bindings }) => {
      const { claimed, runAction } = dispatch({ 'terminal.focusPaneLeft': bindings })
      expect(claimed).toBe(true)
      expect(runAction).toHaveBeenCalledExactlyOnceWith('worktree.history.back')
    }
  )

  it('respects terminal-first while app focus retains history', () => {
    expect(dispatch({ 'terminal.focusPaneLeft': [] }, 'terminal', 'terminal-first').claimed).toBe(
      false
    )
    expect(dispatch(undefined, 'app', 'terminal-first').claimed).toBe(true)
  })

  it('also yields history rebound onto a vertical navigation chord', () => {
    const { claimed } = dispatch({
      'terminal.focusPaneLeft': [],
      'terminal.focusPaneUp': ['Ctrl+Alt+ArrowLeft']
    })
    expect(claimed).toBe(false)
  })

  it('does not yield synthetic double taps to physical terminal listeners', () => {
    const runAction = vi.fn(() => true)
    expect(
      dispatchGlobalPluginAliasActions({
        context: 'terminal',
        isPhysicalKey: false,
        matchShortcut: (action) =>
          action === 'terminal.focusPaneLeft' || action === 'worktree.history.back',
        runAction
      })
    ).toBe(true)
    expect(runAction).toHaveBeenCalledExactlyOnceWith('worktree.history.back')
  })

  it('keeps unrelated aliases working in terminals', () => {
    const runAction = vi.fn(() => true)
    expect(
      dispatchGlobalPluginAliasActions({
        context: 'terminal',
        matchShortcut: (action: KeybindingActionId) => action === 'sidebar.left.toggle',
        runAction
      })
    ).toBe(true)
    expect(runAction).toHaveBeenCalledExactlyOnceWith('sidebar.left.toggle')
  })
})
