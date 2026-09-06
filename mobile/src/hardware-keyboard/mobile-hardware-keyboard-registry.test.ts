import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeRuntime = vi.hoisted(() => ({
  setCommands: vi.fn(),
  policy: 'terminal-first' as 'terminal-first' | 'orca-first',
  preferencesChanged: () => {}
}))

vi.mock('@orca/expo-hardware-keyboard-navigation', () => ({
  addHardwareKeyboardCommandListener: vi.fn(() => ({ remove: vi.fn() })),
  setHardwareKeyboardCommands: nativeRuntime.setCommands
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

vi.mock('./mobile-hardware-keyboard-preferences', () => ({
  getMobileHardwareKeyboardPreferences: () => ({
    loaded: true,
    terminalShortcutPolicy: nativeRuntime.policy
  }),
  loadMobileHardwareKeyboardPreferences: () => Promise.resolve(),
  subscribeMobileHardwareKeyboardPreferences: (listener: () => void) => {
    nativeRuntime.preferencesChanged = listener
    return () => undefined
  }
}))

import { registerMobileHardwareKeyboardScope } from './mobile-hardware-keyboard-registry'

describe('mobile hardware keyboard registry', () => {
  beforeEach(() => {
    nativeRuntime.setCommands.mockClear()
    nativeRuntime.policy = 'terminal-first'
  })

  it('lets the newest scope suppress an overlapping action', () => {
    const unregisterApp = registerMobileHardwareKeyboardScope({
      actionIds: ['tab.nextAllTypes', 'worktree.navigateDown'],
      context: 'app',
      handler: vi.fn()
    })
    const unregisterTerminal = registerMobileHardwareKeyboardScope({
      actionIds: ['tab.nextAllTypes'],
      context: 'terminal',
      handler: vi.fn()
    })

    const commands = nativeRuntime.setCommands.mock.calls.at(-1)?.[0] ?? []
    expect(
      commands.some((command: { actionId: string }) => command.actionId === 'tab.nextAllTypes')
    ).toBe(false)
    expect(
      commands.some((command: { actionId: string }) => command.actionId === 'worktree.navigateDown')
    ).toBe(true)

    unregisterTerminal()
    unregisterApp()
  })

  it('publishes and releases terminal-overlapping chords when the policy changes', () => {
    nativeRuntime.policy = 'orca-first'
    const unregister = registerMobileHardwareKeyboardScope({
      actionIds: [
        'tab.previousRecent',
        'tab.nextTerminal',
        'tab.previousTerminal',
        'tab.nextAllTypes'
      ],
      context: 'terminal',
      handler: vi.fn()
    })
    const registered = () => nativeRuntime.setCommands.mock.calls.at(-1)?.[0] ?? []
    expect(registered()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'Tab', control: true, shift: false }),
        expect.objectContaining({ key: 'PageDown', control: true, shift: false }),
        expect.objectContaining({ key: 'PageUp', control: true, shift: false })
      ])
    )
    nativeRuntime.policy = 'terminal-first'
    nativeRuntime.preferencesChanged()
    expect(registered().map((command: { actionId: string }) => command.actionId)).toEqual([
      'tab.previousRecent',
      'tab.nextTerminal',
      'tab.previousTerminal'
    ])
    nativeRuntime.policy = 'orca-first'
    nativeRuntime.preferencesChanged()
    expect(registered()).toEqual(
      expect.arrayContaining([expect.objectContaining({ actionId: 'tab.nextAllTypes' })])
    )
    unregister()
    expect(registered()).toEqual([])
  })
})
