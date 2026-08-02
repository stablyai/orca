import { describe, expect, it } from 'vitest'
import { EmulatorError } from '../emulator-errors'
import { permissionArgs } from './android-permissions'

describe('permissionArgs', () => {
  it('builds grant args', () => {
    expect(
      permissionArgs('emulator-5554', 'grant', 'com.example.app', 'android.permission.CAMERA')
    ).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'pm',
      'grant',
      'com.example.app',
      'android.permission.CAMERA'
    ])
  })

  it('builds revoke args', () => {
    expect(
      permissionArgs('emulator-5554', 'revoke', 'com.example.app', 'android.permission.CAMERA')
    ).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'pm',
      'revoke',
      'com.example.app',
      'android.permission.CAMERA'
    ])
  })

  it('builds reset-permissions args without a package (it resets all apps)', () => {
    expect(permissionArgs('emulator-5554', 'reset', 'com.example.app')).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'pm',
      'reset-permissions'
    ])
  })

  it('ignores the package and permission for reset', () => {
    expect(
      permissionArgs('emulator-5554', 'reset', 'com.example.app', 'android.permission.CAMERA')
    ).toEqual(['-s', 'emulator-5554', 'shell', 'pm', 'reset-permissions'])
  })

  it('throws EmulatorError with code emulator_error when grant has no permission', () => {
    expect(() => permissionArgs('emulator-5554', 'grant', 'com.example.app')).toThrowError(
      EmulatorError
    )
    try {
      permissionArgs('emulator-5554', 'grant', 'com.example.app')
      throw new Error('expected permissionArgs to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(EmulatorError)
      expect((error as EmulatorError).code).toBe('emulator_error')
    }
  })

  it('throws EmulatorError when revoke has an empty/whitespace permission', () => {
    expect(() => permissionArgs('emulator-5554', 'revoke', 'com.example.app', '   ')).toThrowError(
      EmulatorError
    )
  })
})
