import { describe, expect, it } from 'vitest'
import { EmulatorError } from './emulator-errors'
import { resolveIosHardwareButton } from './ios-simulator-hardware-buttons'

describe('resolveIosHardwareButton', () => {
  it('passes the canonical serve-sim names through unchanged', () => {
    for (const name of ['home', 'lock', 'siri', 'app_switcher', 'swipe_home'] as const) {
      expect(resolveIosHardwareButton(name)).toBe(name)
    }
  })

  it('maps side_button and power to lock', () => {
    expect(resolveIosHardwareButton('side_button')).toBe('lock')
    expect(resolveIosHardwareButton('power')).toBe('lock')
  })

  it('maps the shared Android aliases', () => {
    expect(resolveIosHardwareButton('home_button')).toBe('home')
    for (const alias of ['app_switch', 'recents', 'recent', 'overview']) {
      expect(resolveIosHardwareButton(alias)).toBe('app_switcher')
    }
  })

  it('ignores surrounding whitespace and case', () => {
    expect(resolveIosHardwareButton('  Side_Button ')).toBe('lock')
    expect(resolveIosHardwareButton('HOME')).toBe('home')
  })

  it('rejects an unknown name and lists what it accepts', () => {
    let thrown: unknown
    try {
      resolveIosHardwareButton('volume_up')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(EmulatorError)
    expect((thrown as EmulatorError).code).toBe('emulator_error')
    expect((thrown as EmulatorError).message).toContain('Unknown iOS hardware button: volume_up')
    expect((thrown as EmulatorError).message).toContain(
      'home, lock, side_button, siri, app_switcher, swipe_home'
    )
  })

  it('rejects inherited Object properties instead of resolving them', () => {
    for (const name of ['toString', 'constructor', '__proto__']) {
      expect(() => resolveIosHardwareButton(name)).toThrow(EmulatorError)
    }
  })
})
