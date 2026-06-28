import { describe, expect, it } from 'vitest'
import { currentPlatform, describeKey, resolveAction } from './keybinding-map'
import type { LogicalKey } from './tty-key-adapter'

describe('resolveAction', () => {
  it('maps arrows and vim keys to movement', () => {
    expect(resolveAction({ type: 'up' })).toBe('move-up')
    expect(resolveAction({ type: 'char', value: 'k' })).toBe('move-up')
    expect(resolveAction({ type: 'down' })).toBe('move-down')
    expect(resolveAction({ type: 'char', value: 'j' })).toBe('move-down')
  })

  it('maps Enter to open and Esc to back', () => {
    expect(resolveAction({ type: 'enter' })).toBe('open')
    expect(resolveAction({ type: 'escape' })).toBe('back')
  })

  it('maps q and Ctrl+C to quit', () => {
    expect(resolveAction({ type: 'char', value: 'q' })).toBe('quit')
    expect(resolveAction({ type: 'ctrl', value: 'c' })).toBe('quit')
  })

  it('maps action keys to their commands', () => {
    expect(resolveAction({ type: 'char', value: '?' })).toBe('help')
    expect(resolveAction({ type: 'char', value: 'n' })).toBe('new-worktree')
    expect(resolveAction({ type: 'char', value: 'c' })).toBe('new-terminal')
    expect(resolveAction({ type: 'char', value: 'x' })).toBe('remove-worktree')
  })

  it('returns null for unbound keys', () => {
    expect(resolveAction({ type: 'char', value: 'z' })).toBeNull()
    expect(resolveAction({ type: 'tab' })).toBeNull()
  })
})

describe('describeKey', () => {
  it('renders Control with the macOS glyph on mac and Ctrl+ elsewhere', () => {
    const ctrlB: LogicalKey = { type: 'ctrl', value: 'b' }
    expect(describeKey(ctrlB, 'mac')).toBe('⌃B')
    expect(describeKey(ctrlB, 'other')).toBe('Ctrl+B')
  })

  it('renders arrows and named keys consistently', () => {
    expect(describeKey({ type: 'up' })).toBe('↑')
    expect(describeKey({ type: 'enter' })).toBe('Enter')
    expect(describeKey({ type: 'escape' })).toBe('Esc')
    expect(describeKey({ type: 'char', value: 'q' })).toBe('q')
  })
})

describe('currentPlatform', () => {
  it('classifies darwin as mac and everything else as other', () => {
    expect(currentPlatform('darwin')).toBe('mac')
    expect(currentPlatform('linux')).toBe('other')
    expect(currentPlatform('win32')).toBe('other')
  })
})
