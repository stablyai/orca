import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import type { AndroidCommandRunner } from './android-command-runner'
import type { EmulatorDevice } from '../backends/emulator-backend'

export async function readAndroidDeviceSystemMetadata(
  device: EmulatorDevice,
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths
): Promise<Pick<EmulatorDevice, 'osVersion' | 'apiLevel'>> {
  if (device.state === 'booted') {
    const result = await runner(sdk.adb, ['-s', device.id, 'shell', 'getprop'], { timeoutMs: 5000 })
    if (result.code !== 0) {
      return {}
    }
    const osVersion = result.stdout.match(/\[ro\.build\.version\.release\]: \[([^\]]+)\]/)?.[1]
    const apiLevel = result.stdout.match(/\[ro\.build\.version\.sdk\]: \[([^\]]+)\]/)?.[1]
    return { osVersion, apiLevel }
  }
  if (device.detail !== 'avd' || /[\\/]/.test(device.id)) {
    return {}
  }
  const androidHome =
    process.env.ANDROID_USER_HOME ||
    process.env.ANDROID_EMULATOR_HOME ||
    join(homedir(), '.android')
  const avdHome = process.env.ANDROID_AVD_HOME || join(androidHome, 'avd')
  const ini = await readFile(join(avdHome, `${device.id}.ini`), 'utf8').catch(() => '')
  const configuredPath = ini.match(/^path=(.+)$/m)?.[1]?.trim()
  const avdPath =
    configuredPath && isAbsolute(configuredPath)
      ? configuredPath
      : join(avdHome, `${device.id}.avd`)
  const config = await readFile(join(avdPath, 'config.ini'), 'utf8').catch(() => '')
  const image = config.match(/^image\.sysdir\.1\s*=\s*(.+)$/m)?.[1]?.trim()
  const apiLevel = image?.match(/(?:^|[/\\])android-([^/\\]+)[/\\]/)?.[1]
  if (!image) {
    return {}
  }
  return { apiLevel }
}
