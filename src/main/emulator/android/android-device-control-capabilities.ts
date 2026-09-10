import type { EmulatorDeviceControlCapabilities } from '../../../shared/emulator-device-controls'
import type { AndroidAdbDevice } from './adb-devices'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { androidShellArgs } from './android-input-commands'

const PROBE_TIMEOUT_MS = 2_000

type ProbeResult = {
  stdout: string
  ok: boolean
}

export async function inspectAndroidDeviceControlCapabilities(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  device: AndroidAdbDevice
): Promise<EmulatorDeviceControlCapabilities> {
  const [characteristics, api, states] = await Promise.all([
    runProbe(
      runner,
      sdk.adb,
      androidShellArgs(device.serial, ['getprop', 'ro.build.characteristics'])
    ),
    runProbe(runner, sdk.adb, androidShellArgs(device.serial, ['getprop', 'ro.build.version.sdk'])),
    runProbe(
      runner,
      sdk.adb,
      androidShellArgs(device.serial, ['cmd', 'device_state', 'print-states-simple'])
    )
  ])

  const isWear = characteristics.ok && parseCharacteristics(characteristics.stdout).has('watch')
  const apiLevel = api.ok ? parseApiLevel(api.stdout) : null
  const integerStateIds = states.ok ? parseStateIds(states.stdout) : []

  return {
    shutdown: device.isEmulator,
    power: characteristics.ok ? !isWear || (apiLevel !== null && apiLevel < 28) : true,
    volume: characteristics.ok ? !isWear : true,
    overview: characteristics.ok ? !isWear : true,
    foldable: device.isEmulator && states.ok && integerStateIds.length > 1,
    wearButton1: characteristics.ok && isWear && apiLevel !== null && apiLevel >= 28,
    wearButton2: characteristics.ok && isWear && apiLevel !== null && apiLevel >= 30
  }
}

async function runProbe(
  runner: AndroidCommandRunner,
  adb: string,
  args: readonly string[]
): Promise<ProbeResult> {
  try {
    const result = await runner(adb, args, { timeoutMs: PROBE_TIMEOUT_MS })
    return { ok: result.code === 0, stdout: result.stdout }
  } catch {
    return { ok: false, stdout: '' }
  }
}

function parseCharacteristics(stdout: string): Set<string> {
  return new Set(
    stdout
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
  )
}

function parseApiLevel(stdout: string): number | null {
  const value = stdout.trim()
  if (!/^\d+$/.test(value)) {
    return null
  }
  const api = Number(value)
  return Number.isSafeInteger(api) ? api : null
}

function parseStateIds(stdout: string): number[] {
  const ids: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)(?:\s|:|$)/.exec(line)
    if (match) {
      const id = Number(match[1])
      if (Number.isSafeInteger(id)) {
        ids.push(id)
      }
    }
  }
  return ids
}
