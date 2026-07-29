import { describe, expect, it } from 'vitest'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { androidExec, androidTap } from './android-input-commands'

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
})
