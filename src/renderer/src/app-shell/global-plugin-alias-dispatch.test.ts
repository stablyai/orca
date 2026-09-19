import { describe, expect, it, vi } from 'vitest'
import type { KeybindingActionId } from '../../../shared/keybindings'
import {
  dispatchGlobalPluginAliasActions,
  globalKeybindingSkipsWorktreeHistory
} from './global-plugin-alias-dispatch'

describe('globalKeybindingSkipsWorktreeHistory', () => {
  it('skips worktree history only in terminal context', () => {
    expect(globalKeybindingSkipsWorktreeHistory('terminal', 'worktree.history.back')).toBe(true)
    expect(globalKeybindingSkipsWorktreeHistory('terminal', 'worktree.history.forward')).toBe(true)
    expect(globalKeybindingSkipsWorktreeHistory('app', 'worktree.history.back')).toBe(false)
    expect(globalKeybindingSkipsWorktreeHistory('app', 'worktree.history.forward')).toBe(false)
    expect(globalKeybindingSkipsWorktreeHistory('terminal', 'sidebar.left.toggle')).toBe(false)
  })
})

describe('dispatchGlobalPluginAliasActions', () => {
  it('does not run worktree history from global capture while a terminal is focused', () => {
    const runAction = vi.fn((actionId: KeybindingActionId) => {
      return actionId === 'worktree.history.back' || actionId === 'sidebar.left.toggle'
    })

    expect(
      dispatchGlobalPluginAliasActions({
        context: 'terminal',
        matchShortcut: (actionId) =>
          actionId === 'worktree.history.back' || actionId === 'worktree.history.forward',
        runAction
      })
    ).toBe(false)
    expect(runAction).not.toHaveBeenCalled()
  })

  it('still runs worktree history from global capture in app context', () => {
    const runAction = vi.fn((actionId: KeybindingActionId) => actionId === 'worktree.history.back')

    expect(
      dispatchGlobalPluginAliasActions({
        context: 'app',
        matchShortcut: (actionId) => actionId === 'worktree.history.back',
        runAction
      })
    ).toBe(true)
    expect(runAction).toHaveBeenCalledWith('worktree.history.back')
  })

  it('still runs other aliases in terminal context', () => {
    const runAction = vi.fn((actionId: KeybindingActionId) => actionId === 'sidebar.left.toggle')

    expect(
      dispatchGlobalPluginAliasActions({
        context: 'terminal',
        matchShortcut: (actionId) => actionId === 'sidebar.left.toggle',
        runAction
      })
    ).toBe(true)
    expect(runAction).toHaveBeenCalledWith('sidebar.left.toggle')
  })
})
