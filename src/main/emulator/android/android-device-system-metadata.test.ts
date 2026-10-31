import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readAndroidDeviceSystemMetadata } from './android-device-system-metadata'

let directory: string | undefined
afterEach(async () => {
  vi.unstubAllEnvs()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})
it('reads the API of a stopped AVD from its configured custom data directory', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-avd-metadata-'))
  const avdHome = join(directory, 'avds')
  const data = join(directory, 'custom-data')
  await mkdir(avdHome)
  await mkdir(data)
  await writeFile(join(avdHome, 'Pixel.ini'), `path=${data}\n`)
  await writeFile(
    join(data, 'config.ini'),
    'image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n'
  )
  vi.stubEnv('ANDROID_AVD_HOME', avdHome)
  const runner = vi.fn()
  expect(
    await readAndroidDeviceSystemMetadata(
      {
        backend: 'android',
        id: 'Pixel',
        name: 'Pixel',
        detail: 'avd',
        state: 'shutdown',
        isAvailable: true
      },
      runner,
      { sdkRoot: '/sdk', adb: '/sdk/adb', emulator: '/sdk/emulator', avdmanager: '/sdk/avdmanager' }
    )
  ).toEqual({ apiLevel: '36' })
  expect(runner).not.toHaveBeenCalled()
})
