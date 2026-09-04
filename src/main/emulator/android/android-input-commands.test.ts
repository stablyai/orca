import { describe, expect, it } from 'vitest'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { androidButton, androidExec, androidSetPosture, androidTap } from './android-input-commands'

const SDK: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  emulator: '/sdk/emulator',
  avdmanager: '/sdk/avdmanager'
}

const ok: AndroidCommandResult = { stdout: 'ok', stderr: '', code: 0 }
const fail: AndroidCommandResult = { stdout: '', stderr: 'device offline', code: 1 }

describe('android input commands', () => {
  it('throws when adb tap exits non-zero', async () => {
    const runner: AndroidCommandRunner = async () => fail

    await expect(
      androidTap(runner, SDK, 'emulator-5554', 0.5, 0.5, { width: 100, height: 200 })
    ).rejects.toMatchObject({
      code: 'emulator_error',
      message: 'adb tap failed: device offline'
    })
  })

  it('returns stdout for successful exec and throws for failed exec', async () => {
    const successRunner: AndroidCommandRunner = async () => ok
    await expect(androidExec(successRunner, SDK, 'emulator-5554', 'echo ok')).resolves.toBe('ok')

    const failRunner: AndroidCommandRunner = async () => fail
    await expect(androidExec(failRunner, SDK, 'emulator-5554', 'false')).rejects.toMatchObject({
      code: 'emulator_error',
      message: 'adb exec failed: device offline'
    })
  })
  it('sends posture commands through the emulator console', async () => {
    const calls: (readonly string[])[] = []
    const runner: AndroidCommandRunner = async (_command, args) => {
      calls.push(args)
      return ok
    }

    await androidSetPosture(runner, SDK, 'emulator-5554', 'folded')
    await androidSetPosture(runner, SDK, 'emulator-5554', 'unfolded')

    expect(calls).toEqual([
      ['-s', 'emulator-5554', 'emu', 'fold'],
      ['-s', 'emulator-5554', 'emu', 'unfold']
    ])
  })

  it('adds long-press only when requested', async () => {
    const calls: (readonly string[])[] = []
    const runner: AndroidCommandRunner = async (_command, args) => {
      calls.push(args)
      return ok
    }

    await androidButton(runner, SDK, 'emulator-5554', 'power', { longPress: true })
    await androidButton(runner, SDK, 'emulator-5554', 'power')

    expect(calls).toEqual([
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '--longpress', '26'],
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '26']
    ])
  })

  it('propagates non-zero posture errors', async () => {
    const runner: AndroidCommandRunner = async () => fail

    await expect(androidSetPosture(runner, SDK, 'emulator-5554', 'folded')).rejects.toMatchObject({
      code: 'emulator_error',
      message: 'adb posture failed: device offline'
    })
  })
})
