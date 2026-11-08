import { AndroidStreamController } from '../../../src/main/emulator/android/android-stream-controller'
import { startAndroidStreamSession } from '../../../src/main/emulator/android/android-stream-session-starter'
import { nativeAndroidSessions } from '../../../src/main/emulator/android/emulator-grpc-session'
import { execFileAndroidCommandRunner as run } from '../../../src/main/emulator/android/android-command-runner'
import { parseArgs } from 'node:util'
import { discoverAndroidSdkFromHost } from '../../../src/main/emulator/android/android-sdk-host-discovery'
const { values } = parseArgs({ options: { serial: { type: 'string' }, jar: { type: 'string' } } })
const sdk = discoverAndroidSdkFromHost()
const serial = values.serial
const jar = values.jar
if (!sdk || !serial || !/^emulator-\d+$/.test(serial) || !jar) {
  throw new Error(
    'Use --serial emulator-N --jar /path/to/scrcpy-server-v2.4.jar with a dedicated test AVD'
  )
}
const adb = sdk.adb
async function shell(...args: string[]) {
  const r = await run(adb, ['-s', serial, 'shell', ...args])
  if (r.code) {
    throw new Error(r.stderr)
  }
  return r.stdout
}
async function xml() {
  await shell('uiautomator', 'dump', '/sdcard/orca-input-check.xml')
  return shell('cat', '/sdcard/orca-input-check.xml')
}
async function main() {
  await shell('am', 'force-stop', 'com.android.settings')
  await shell('am', 'start', '-a', 'android.settings.SETTINGS')
  const screen = await xml()
  const tag = screen.match(
    /<node[^>]*resource-id="com.android.settings:id\/search_action_bar"[^>]*>/
  )?.[0]
  const bounds = tag?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
  if (!bounds) {
    throw new Error('Search target unavailable')
  }
  await shell(
    'input',
    'tap',
    String((Number(bounds[1]) + Number(bounds[3])) / 2),
    String((Number(bounds[2]) + Number(bounds[4])) / 2)
  )
  await xml()
  const controller = new AndroidStreamController({
    runner: run,
    sdk: () => sdk!,
    ensureJar: async () => jar!,
    startStreamSession: startAndroidStreamSession,
    maxSize: 1280,
    nativeEmulator: true
  })
  await controller.start(serial!)
  const session = nativeAndroidSessions.get(serial!)
  if (!session) {
    await controller.stop(serial!)
    throw new Error('Native stream unavailable; controller fell back to encoded video')
  }
  try {
    for (const text of 'Orca42') {
      await session.keyboard({ text })
    }
    await session.keyboard({ key: 'backspace', shift: false })
    let result = await xml()
    if (!result.includes('text="Orca4"')) {
      throw new Error(`Typing/backspace failed: ${result.match(/text="[^"]*"/g)?.join(' ')}`)
    }
    await session.keyboard({ key: 'a', shift: false, ctrl: true })
    await session.keyboard({ text: 'native paste 你好' })
    result = await xml()
    if (!result.includes('text="native paste 你好"')) {
      throw new Error(
        `Select-all/Unicode paste failed: ${result.match(/text="[^"]*"/g)?.join(' ')}`
      )
    }
    console.log('PASS: real emulator typing, Backspace, Control+A, Unicode clipboard paste')
  } finally {
    await controller.stop(serial!)
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
