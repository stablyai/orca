import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { bootAndroidDevice } from './android-avd-boot'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'

// bootAndroidDevice launches the emulator via spawn (not the command runner);
// stub it so a mistaken AVD spawn is observable and never actually runs.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, spawn: vi.fn(() => ({ on: () => {}, unref: () => {} })) }
})

const SDK: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  avdTools: { emulator: '/sdk/emulator', avdmanager: '/sdk/avdmanager' }
}

const ok = (stdout: string): AndroidCommandResult => ({ stdout, stderr: '', code: 0 })

const BOOT_OPTIONS = { bootTimeoutMs: 5_000, pollIntervalMs: 10, sleep: async () => {} }

describe('bootAndroidDevice', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear()
  })

  it('passes through an already-running serial without adb/emulator calls', async () => {
    const runner = vi.fn(async (binary: string, args: readonly string[]) => {
      const a = args.join(' ')
      if (binary === SDK.adb && a === 'devices -l') {
        return ok('List of devices attached\nemulator-5554\tdevice')
      }
      return ok('')
    })
    const serial = await bootAndroidDevice(
      runner as unknown as AndroidCommandRunner,
      SDK,
      'emulator-5554',
      BOOT_OPTIONS
    )
    expect(serial).toBe('emulator-5554')
  })

  it('rejects an offline ADB network address with emulator_adb_not_connected, never listing AVDs or spawning', async () => {
    const calls: { binary: string; args: readonly string[] }[] = []
    const runner = vi.fn(async (binary: string, args: readonly string[]) => {
      calls.push({ binary, args })
      const a = args.join(' ')
      if (binary === SDK.adb && a === 'devices -l') {
        return ok('List of devices attached')
      }
      return ok('')
    })

    await expect(
      bootAndroidDevice(
        runner as unknown as AndroidCommandRunner,
        SDK,
        '192.168.1.50:5555',
        BOOT_OPTIONS
      )
    ).rejects.toMatchObject({
      code: 'emulator_adb_not_connected',
      message: expect.stringContaining('Settings > Mobile Emulator')
    })

    // Only the `adb devices -l` / avd-name-resolution lookups happened, never
    // `adb connect`, never `-list-avds`, never the emulator spawn.
    expect(spawn).not.toHaveBeenCalled()
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain('connect')
      expect(call.binary).not.toBe(SDK.avdTools?.emulator)
    }
  })
})
