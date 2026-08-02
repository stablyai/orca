import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { ensureAdbOk } from './android-adb-result'
import {
  androidButtonKeycode,
  normalizedToDevicePixels,
  type DeviceScreenSize
} from './android-input-mapping'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

// Android control via `adb shell input`, so it works without the scrcpy server.
// The backend resolves the serial + screen size and delegates here.

export function androidShellArgs(serial: string, command: readonly string[]): string[] {
  return ['-s', serial, 'shell', ...command]
}

export async function androidTap(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  x: number,
  y: number,
  size: DeviceScreenSize
): Promise<void> {
  const pixel = normalizedToDevicePixels(x, y, size)
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, ['input', 'tap', String(pixel.x), String(pixel.y)])
    ),
    'adb tap'
  )
}

export async function androidSwipe(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  points: EmulatorGesturePoint[],
  size: DeviceScreenSize
): Promise<void> {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last || points.length < 2) {
    return
  }
  // adb input only supports a straight swipe, so approximate the path by its
  // endpoints; the scrcpy control phase replaces this with true multi-touch.
  const start = normalizedToDevicePixels(first.x, first.y, size)
  const end = normalizedToDevicePixels(last.x, last.y, size)
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, [
        'input',
        'swipe',
        String(start.x),
        String(start.y),
        String(end.x),
        String(end.y),
        '300'
      ])
    ),
    'adb swipe'
  )
}

export async function androidTypeText(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  text: string
): Promise<void> {
  // adb input text uses %s for spaces and cannot carry newlines.
  ensureAdbOk(
    await runner(sdk.adb, androidShellArgs(serial, ['input', 'text', text.replace(/ /g, '%s')])),
    'adb type'
  )
}

export async function androidButton(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  name: string
): Promise<void> {
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, ['input', 'keyevent', String(androidButtonKeycode(name))])
    ),
    'adb button'
  )
}

export async function androidRotate(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  orientation: string
): Promise<void> {
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, ['settings', 'put', 'system', 'accelerometer_rotation', '0'])
    ),
    'adb rotate'
  )
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, [
        'settings',
        'put',
        'system',
        'user_rotation',
        String(orientationToRotation(orientation))
      ])
    ),
    'adb rotate'
  )
}

export async function androidExec(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  command: string
): Promise<string> {
  // Pass the whole command as a single arg so the device shell parses quotes,
  // pipes, and compound commands instead of naively splitting on spaces.
  const result = ensureAdbOk(await runner(sdk.adb, androidShellArgs(serial, [command])), 'adb exec')
  return result.stdout
}

function orientationToRotation(orientation: string): number {
  switch (orientation) {
    case 'landscape_left':
      return 1
    case 'portrait_upside_down':
      return 2
    case 'landscape_right':
      return 3
    default:
      return 0
  }
}
