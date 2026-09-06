import { describe, expect, it } from 'vitest'
import {
  assertHostedAndroidBridgeLogClean,
  findHostedAndroidBridgeLogFailures,
  installAndResetHostedAndroidApp,
  waitForHostedAndroidReactReady
} from '../../scripts/hosted-android-emulator-session.mjs'

describe('hosted Android emulator session', () => {
  it('finds native bridge rejection, conversion, cast, and process failures', () => {
    const failures = findHostedAndroidBridgeLogFailures(`
      E/ReactNativeJS: Call to function 'ExpoMobileWebShell.postViewMessage' has been rejected.
      E/ReactNativeJS: java.lang.IllegalArgumentException: mobile_web_shell_view_unavailable
      E/ExpoModules: Cannot convert '{}' to a Kotlin type
      E/AndroidRuntime: java.lang.ClassCastException: View cannot be cast to MobileWebShellView
      E/AndroidRuntime: FATAL EXCEPTION: main
    `)

    expect(failures).toHaveLength(5)
  })

  it('ignores normal Android runtime and WebView output', () => {
    expect(
      findHostedAndroidBridgeLogFailures(`
        D/AndroidRuntime: Calling main entry com.android.commands.uiautomator.Launcher
        I/chromium: source: https://orca-mobile-web.invalid/
      `)
    ).toEqual([])
  })

  it('ignores automation-process fatals while retaining app-process fatals', () => {
    const logcat = `
      E/AndroidRuntime(20196): FATAL EXCEPTION: UiAutomation
      E/AndroidRuntime(20200): FATAL EXCEPTION: main
    `

    expect(findHostedAndroidBridgeLogFailures(logcat, '20200')).toEqual([
      '      E/AndroidRuntime(20200): FATAL EXCEPTION: main'
    ])
  })

  it('waits for the current Android app process to mount React main', async () => {
    const responses = [
      '7301',
      'I/ReactNativeJS: Loading bundle',
      '7301',
      'I/ReactNativeJS: Running "main"'
    ]
    const runAdb = async () => responses.shift() ?? ''

    await expect(waitForHostedAndroidReactReady('adb', 2_000, runAdb)).resolves.toBe('7301')
  })

  it('allows an exact debug APK to replace a higher-version beta install', async () => {
    const calls: { args: string[]; timeout?: number }[] = []
    const runAdb = async (_adb: string, args: string[], timeout?: number) => {
      calls.push({ args, timeout })
      return ''
    }

    await installAndResetHostedAndroidApp('adb', '/tmp/app-debug.apk', runAdb)

    expect(calls[0]).toEqual({
      args: ['install', '-r', '-d', '-t', '/tmp/app-debug.apk'],
      timeout: 120_000
    })
    expect(calls[1]?.args).toEqual(['shell', 'pm', 'clear', 'com.stably.orca.mobile'])
  })

  it('scopes the bridge audit to the current Android app process', async () => {
    const calls: string[][] = []
    const runAdb = async (_adb: string, args: string[]) => {
      calls.push(args)
      return calls.length === 1 ? '7301' : 'I/chromium: hosted route'
    }

    await expect(assertHostedAndroidBridgeLogClean('adb', runAdb)).resolves.toBeUndefined()
    expect(calls).toEqual([
      ['shell', 'pidof', 'com.stably.orca.mobile'],
      ['logcat', '--pid', '7301', '-d', '-v', 'brief']
    ])
  })
})
