import { describe, expect, it, vi } from 'vitest'
import { bootAndroidDevice } from './android-avd-boot'
import type { AndroidSdkPaths } from './android-sdk-discovery'

vi.mock('node:child_process', () => ({
  spawn: () => ({ on: vi.fn(), unref: vi.fn() })
}))

const sdk: AndroidSdkPaths = {
  sdkRoot: 'sdk',
  adb: 'adb',
  emulator: 'emulator',
  avdmanager: 'avdmanager'
}
type Device = { serial: string; name: string; booted: boolean }
const other: Device = { serial: 'emulator-5556', name: 'Other', booted: true }
const target: Device = {
  serial: 'emulator-5558',
  name: 'Wanted',
  booted: true
}

function bootWithInventory(snapshots: Device[][]) {
  let reads = 0
  let current: Device[] = []
  const runner = vi.fn(async (binary: string, args: readonly string[]) => {
    let stdout = ''
    if (binary === sdk.emulator && args[0] === '-list-avds') {
      stdout = 'Wanted\nOther\n'
    } else if (args[0] === 'devices') {
      current = snapshots[Math.min(reads++, snapshots.length - 1)]
      stdout = `List of devices attached\n${current.map((d) => `${d.serial}\tdevice`).join('\n')}`
    } else {
      const device = current.find((d) => d.serial === args[1])
      stdout = args[2] === 'emu' ? `${device?.name ?? ''}\nOK\n` : device?.booted ? '1' : '0'
    }
    return { code: 0, stdout, stderr: '' }
  })
  return bootAndroidDevice(runner, sdk, 'Wanted', {
    bootTimeoutMs: 30,
    pollIntervalMs: 10,
    sleep: async () => {}
  })
}

describe('Android AVD boot identity', () => {
  it('waits for the requested AVD when another emulator boots first', async () => {
    await expect(
      bootWithInventory([[], [other], [other, { ...target, booted: false }], [other, target]])
    ).resolves.toBe(target.serial)
    await expect(bootWithInventory([[], [other]])).rejects.toThrow(
      'AVD "Wanted" did not finish booting in time.'
    )
  })
})
