import { parseArgs } from 'node:util'
import { discoverAndroidSdkFromHost } from '../../../src/main/emulator/android/android-sdk-host-discovery'
import { execFileAndroidCommandRunner as runner } from '../../../src/main/emulator/android/android-command-runner'
import { ScrcpyStreamSession } from '../../../src/main/emulator/android/scrcpy-stream-session'
import { startNativeAndroidSession } from '../../../src/main/emulator/android/emulator-grpc-session'
import { sendScrcpyTouch } from '../../../src/main/emulator/android/scrcpy-control-input'

/** Measures transport delivery on a dedicated AVD, not end-to-end Electron presentation latency. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      serial: { type: 'string' },
      transport: { type: 'string' },
      jar: { type: 'string' },
      width: { type: 'string', default: '576' },
      height: { type: 'string', default: '1280' }
    }
  })
  const serial = values.serial
  const sdk = discoverAndroidSdkFromHost()
  const width = Number(values.width),
    height = Number(values.height)
  if (
    !sdk ||
    !serial ||
    !/^emulator-\d+$/.test(serial) ||
    !['grpc', 'scrcpy'].includes(values.transport ?? '') ||
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0
  ) {
    throw new Error(
      'Use --serial emulator-N --transport grpc|scrcpy [--jar scrcpy-server.jar] [--width N --height N]'
    )
  }
  const command = async (args: string[]) => {
    const result = await runner(sdk.adb, ['-s', serial, 'shell', ...args])
    if (result.code) {
      throw new Error(result.stderr)
    }
  }
  await command(['am', 'force-stop', 'com.android.settings'])
  await command(['am', 'start', '-a', 'android.settings.SETTINGS', '-f', '0x10008000'])
  let frames = 0,
    bytes = 0,
    measuring = false,
    waitingInputAt: number | null = null
  let actualSize: { width: number; height: number } | null = null
  const frameAges: number[] = [],
    nextFrameAfterInput: number[] = []
  const received = (length: number, timestampUs?: string) => {
    if (!measuring) {
      return
    }
    frames++
    bytes += length
    if (timestampUs) {
      frameAges.push(Date.now() - Number(timestampUs) / 1000)
    }
    if (waitingInputAt !== null) {
      nextFrameAfterInput.push(performance.now() - waitingInputAt)
      waitingInputAt = null
    }
  }
  let touch: (phase: 'begin' | 'move' | 'end', x: number, y: number) => boolean
  let close: () => void | Promise<void>
  if (values.transport === 'grpc') {
    const session = await startNativeAndroidSession(serial)
    if (!session) {
      throw new Error('Authenticated native gRPC unavailable')
    }
    const unsubscribe = session.subscribe({
      width,
      height,
      frame: (frame) => {
        actualSize ??= { width: frame.width, height: frame.height }
        received(frame.pixels.byteLength, frame.timestampUs)
      },
      end: () => {}
    })
    touch = (phase, x, y) => session.touch(phase, x, y)
    close = () => {
      unsubscribe()
      return session.close()
    }
  } else {
    if (!values.jar) {
      throw new Error('scrcpy requires --jar')
    }
    const session = await ScrcpyStreamSession.start(
      { runner, sdk, serial, localJarPath: values.jar, maxSize: Math.max(width, height) },
      {
        onMeta: (meta) => {
          actualSize = { width: meta.width, height: meta.height }
          console.error(JSON.stringify(meta))
        },
        onFrame: (frame) => {
          if (!frame.config) {
            received(frame.data.byteLength)
          }
        },
        onError: (error) => console.error(error),
        onClose: () => {}
      }
    )
    touch = (phase, x, y) => sendScrcpyTouch(session, phase, x, y)
    close = () => session.close()
  }
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  try {
    await sleep(2000)
    const cpu = process.cpuUsage(),
      start = performance.now()
    measuring = true
    for (let index = 0; index < 10; index++) {
      waitingInputAt = performance.now()
      touch('begin', 0.5, 0.8)
      for (let step = 1; step <= 20; step++) {
        touch('move', 0.5, 0.8 - step * 0.025)
        await sleep(16)
      }
      touch('end', 0.5, 0.3)
      await sleep(150)
    }
    measuring = false
    const seconds = (performance.now() - start) / 1000
    const usage = process.cpuUsage(cpu)
    const percentile = (values: number[], fraction: number) =>
      values.length
        ? [...values].sort((a, b) => a - b)[
            Math.min(values.length - 1, Math.floor(values.length * fraction))
          ]
        : null
    console.log(
      JSON.stringify({
        transport: values.transport,
        serial,
        viewport: { width, height },
        actualSize,
        seconds,
        frames,
        bytes,
        nodeCpuPercent: (usage.user + usage.system) / (seconds * 10000),
        frameAgeReceiveMs: { p50: percentile(frameAges, 0.5), p95: percentile(frameAges, 0.95) },
        nextFrameAfterInputMs: {
          p50: percentile(nextFrameAfterInput, 0.5),
          p95: percentile(nextFrameAfterInput, 0.95)
        },
        limitations:
          'Receive-side only. Next frame after input may be unrelated animation; it is not input-to-visible response latency. Excludes Electron, rendering and emulator CPU. scrcpy has no comparable wall-clock frame timestamp.'
      })
    )
  } finally {
    await close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
