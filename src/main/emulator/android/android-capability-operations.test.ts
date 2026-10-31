import { describe, expect, it, vi } from 'vitest'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import {
  captureAndroidLogcat,
  dumpAndroidAccessibilityTree,
  installAndroidApk,
  launchAndroidApp
} from './android-capability-operations'

const SDK: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  emulator: '/sdk/emulator',
  avdmanager: '/sdk/avdmanager'
}

const ok = (stdout: string): AndroidCommandResult => ({ stdout, stderr: '', code: 0 })

describe('captureAndroidLogcat', () => {
  it('keeps process identity for same-tag entries and preserves buffer headers', async () => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValue(
      ok(`--------- beginning of main
06-26 12:00:00.123  1234  5678 E MyTag: first: failure

06-26 12:00:01.456  4321  8765 I MyTag: second process
`)
    )

    await expect(captureAndroidLogcat(runner, SDK, 'emulator-5554')).resolves.toEqual([
      { message: '--------- beginning of main' },
      {
        timestamp: '06-26 12:00:00.123',
        pid: 1234,
        tid: 5678,
        level: 'E',
        tag: 'MyTag',
        message: 'first: failure'
      },
      {
        timestamp: '06-26 12:00:01.456',
        pid: 4321,
        tid: 8765,
        level: 'I',
        tag: 'MyTag',
        message: 'second process'
      }
    ])
  })
})

function runnerReturning(map: Record<string, AndroidCommandResult>): AndroidCommandRunner {
  return (async (_binary: string, args: readonly string[]) =>
    map[args.join(' ')] ?? ok('')) as unknown as AndroidCommandRunner
}

describe('installAndroidApk', () => {
  it('installs and throws on a Failure stdout even with exit 0', async () => {
    const good = vi.fn(runnerReturning({ '-s s install /a.apk': ok('Success') }))
    await installAndroidApk(good as unknown as AndroidCommandRunner, SDK, 's', '/a.apk')
    expect(good).toHaveBeenCalledWith(SDK.adb, ['-s', 's', 'install', '/a.apk'])

    const bad = runnerReturning({ '-s s install /a.apk': ok('Failure [INSTALL_FAILED]') })
    await expect(installAndroidApk(bad, SDK, 's', '/a.apk')).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })
})

describe('dumpAndroidAccessibilityTree', () => {
  it.each([
    { stdout: '', stderr: 'ERROR: could not get idle state.' },
    { stdout: 'ERROR: could not get idle state.', stderr: 'WARNING: diagnostic output' }
  ])('rejects a zero-exit dump failure before reading stale XML: %j', async (diagnostic) => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValueOnce({ ...diagnostic, code: 0 })
    runner.mockResolvedValue(ok('<hierarchy><node text="Old screen"/></hierarchy>'))

    await expect(dumpAndroidAccessibilityTree(runner, SDK, 's')).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('ERROR:')
    })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('reads a successful dump despite unrelated stderr warnings', async () => {
    const runner = vi.fn<AndroidCommandRunner>()
    runner.mockResolvedValueOnce({
      code: 0,
      stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml',
      stderr: 'WARNING: diagnostic output'
    })
    runner.mockResolvedValueOnce(ok('<hierarchy><node text="Current screen"/></hierarchy>'))

    const tree = await dumpAndroidAccessibilityTree(runner, SDK, 's')
    expect(tree.children[0]).toMatchObject({ text: 'Current screen' })
    expect(runner).toHaveBeenCalledTimes(2)
  })
})

describe('launchAndroidApp', () => {
  it.each([
    { stdout: '', stderr: 'Error type 3\nError: Activity class {com.x/.Missing} does not exist.' },
    { stdout: 'Error: Activity class {com.x/.Missing} does not exist.', stderr: '' }
  ])('rejects a zero-exit activity launch failure: %j', async (diagnostic) => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValue({ ...diagnostic, code: 0 })

    await expect(launchAndroidApp(runner, SDK, 's', 'com.x', '.Missing')).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('Error:')
    })
  })

  it('accepts a successful launch with a brought-to-front warning', async () => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValue({
      code: 0,
      stdout: 'Starting: Intent { cmp=com.Error/.ErrorActivity }',
      stderr: 'Warning: Activity not started, its current task has been brought to the front'
    })

    await expect(
      launchAndroidApp(runner, SDK, 's', 'com.Error', '.ErrorActivity')
    ).resolves.toBeUndefined()
  })
})
