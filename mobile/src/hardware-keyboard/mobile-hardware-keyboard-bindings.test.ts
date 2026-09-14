import { describe, expect, it } from 'vitest'
import { MOBILE_HARDWARE_KEYBOARD_ACTIONS } from './mobile-hardware-keyboard-actions'
import { buildMobileHardwareKeyboardCommands } from './mobile-hardware-keyboard-bindings'

describe('mobile hardware keyboard bindings', () => {
  it('maps Mod to Ctrl on Android and expands workspace digits', () => {
    const commands = buildMobileHardwareKeyboardCommands({
      actionIds: MOBILE_HARDWARE_KEYBOARD_ACTIONS,
      context: 'app',
      platform: 'linux',
      terminalShortcutPolicy: 'orca-first'
    })

    expect(commands).toContainEqual({
      actionId: 'worktree.navigateDown',
      key: 'ArrowDown',
      control: true,
      meta: false,
      alt: false,
      shift: true
    })
    expect(
      commands.filter((command) => command.actionId === 'workspace.selectByIndex').map((c) => c.key)
    ).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
  })

  it('maps Mod to Command on iOS while preserving Ctrl-only tab commands', () => {
    const commands = buildMobileHardwareKeyboardCommands({
      actionIds: MOBILE_HARDWARE_KEYBOARD_ACTIONS,
      context: 'app',
      platform: 'darwin',
      terminalShortcutPolicy: 'orca-first'
    })

    expect(commands).toContainEqual({
      actionId: 'worktree.history.back',
      key: 'ArrowLeft',
      control: false,
      meta: true,
      alt: true,
      shift: false
    })
    expect(commands).toContainEqual({
      actionId: 'tab.previousRecent',
      key: 'Tab',
      control: true,
      meta: false,
      alt: false,
      shift: false
    })
  })

  it('lets terminal-first pass non-allowed navigation chords to the terminal', () => {
    const commands = buildMobileHardwareKeyboardCommands({
      actionIds: MOBILE_HARDWARE_KEYBOARD_ACTIONS,
      context: 'terminal',
      platform: 'linux',
      terminalShortcutPolicy: 'terminal-first'
    })

    expect(commands.some((command) => command.actionId === 'tab.nextAllTypes')).toBe(false)
    expect(commands.some((command) => command.actionId === 'worktree.navigateUp')).toBe(false)
    expect(commands.some((command) => command.actionId === 'worktree.navigateDown')).toBe(false)
    expect(commands.some((command) => command.actionId === 'worktree.palette')).toBe(false)
    expect(commands.some((command) => command.actionId === 'workspace.selectByIndex')).toBe(false)
    expect(commands.some((command) => command.actionId === 'tab.nextTerminal')).toBe(true)
    expect(commands.some((command) => command.actionId === 'worktree.history.back')).toBe(true)
  })
})
