import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeRuntime = vi.hoisted(() => ({
  setCommands: vi.fn()
}))

vi.mock('@orca/expo-hardware-keyboard-navigation', () => ({
  addHardwareKeyboardCommandListener: vi.fn(() => ({ remove: vi.fn() })),
  setHardwareKeyboardCommands: nativeRuntime.setCommands
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

vi.mock('./mobile-hardware-keyboard-preferences', () => ({
  getMobileHardwareKeyboardPreferences: () => ({
    loaded: true,
    terminalShortcutPolicy: 'terminal-first'
  }),
  loadMobileHardwareKeyboardPreferences: () => Promise.resolve(),
  subscribeMobileHardwareKeyboardPreferences: () => () => undefined
}))

import { registerMobileHardwareKeyboardScope } from './mobile-hardware-keyboard-registry'

describe('mobile hardware keyboard registry', () => {
  beforeEach(() => {
    nativeRuntime.setCommands.mockClear()
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
})
