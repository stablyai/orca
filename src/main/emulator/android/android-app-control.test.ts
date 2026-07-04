import { describe, expect, it } from 'vitest'
import { installApkArgs, launchAppArgs } from './android-app-control'

describe('installApkArgs', () => {
  it('builds install args without -r by default', () => {
    expect(installApkArgs('emulator-5554', '/tmp/app.apk')).toEqual([
      '-s',
      'emulator-5554',
      'install',
      '/tmp/app.apk'
    ])
  })

  it('omits -r when reinstall is false', () => {
    expect(installApkArgs('emulator-5554', '/tmp/app.apk', { reinstall: false })).toEqual([
      '-s',
      'emulator-5554',
      'install',
      '/tmp/app.apk'
    ])
  })

  it('adds -r before the apk path when reinstall is true', () => {
    expect(installApkArgs('emulator-5554', '/tmp/app.apk', { reinstall: true })).toEqual([
      '-s',
      'emulator-5554',
      'install',
      '-r',
      '/tmp/app.apk'
    ])
  })
})

describe('launchAppArgs', () => {
  it('uses am start with the explicit package/activity component', () => {
    expect(launchAppArgs('emulator-5554', 'com.example.app', '.MainActivity')).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-n',
      'com.example.app/.MainActivity'
    ])
  })

  it('falls back to monkey LAUNCHER when no activity is given', () => {
    expect(launchAppArgs('emulator-5554', 'com.example.app')).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'monkey',
      '-p',
      'com.example.app',
      '-c',
      'android.intent.category.LAUNCHER',
      '1'
    ])
  })

  it('falls back to monkey when the activity is an empty/whitespace string', () => {
    expect(launchAppArgs('emulator-5554', 'com.example.app', '   ')).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'monkey',
      '-p',
      'com.example.app',
      '-c',
      'android.intent.category.LAUNCHER',
      '1'
    ])
  })
})
