import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import { ensureHarmonyOk } from './harmony-command-result'
import { hdcTargetArgs } from './hdc-targets'
import {
  harmonyButtonKeycode,
  normalizedToDevicePixels,
  type DeviceScreenSize
} from './harmony-input-mapping'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

// HarmonyOS control via hdc shell (`uinput` for touch, `uitest` for text/keys),
// so it works without any Orca-side helper on the device.

export async function harmonyTap(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  x: number,
  y: number,
  size: DeviceScreenSize
): Promise<void> {
  const pixel = normalizedToDevicePixels(x, y, size)
  ensureHarmonyOk(
    await runner(
      sdk.hdc,
      hdcTargetArgs(connectKey, ['shell', 'uinput', '-T', '-c', String(pixel.x), String(pixel.y)])
    ),
    'hdc tap'
  )
}

export async function harmonySwipe(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  points: EmulatorGesturePoint[],
  size: DeviceScreenSize
): Promise<void> {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last || points.length < 2) {
    return
  }
  // uinput supports a straight swipe; approximate the path by its endpoints.
  const start = normalizedToDevicePixels(first.x, first.y, size)
  const end = normalizedToDevicePixels(last.x, last.y, size)
  ensureHarmonyOk(
    await runner(
      sdk.hdc,
      hdcTargetArgs(connectKey, [
        'shell',
        'uinput',
        '-T',
        '-m',
        String(start.x),
        String(start.y),
        String(end.x),
        String(end.y),
        '300'
      ])
    ),
    'hdc swipe'
  )
}

export async function harmonyTypeText(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  text: string
): Promise<void> {
  ensureHarmonyOk(
    await runner(
      sdk.hdc,
      hdcTargetArgs(connectKey, ['shell', 'uitest', 'uiInput', 'text', quoteShellArg(text)])
    ),
    'hdc type'
  )
}

export async function harmonyButton(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  name: string
): Promise<void> {
  ensureHarmonyOk(
    await runner(
      sdk.hdc,
      hdcTargetArgs(connectKey, [
        'shell',
        'uitest',
        'uiInput',
        'keyEvent',
        String(harmonyButtonKeycode(name))
      ])
    ),
    'hdc button'
  )
}

export async function harmonyExec(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  command: string
): Promise<string> {
  // Single arg so the device shell parses quotes, pipes and compounds itself.
  const result = ensureHarmonyOk(
    await runner(sdk.hdc, hdcTargetArgs(connectKey, ['shell', command])),
    'hdc exec'
  )
  return result.stdout
}

// Orientation indices increment with a `-rotation left` step.
export function orientationIndex(orientation: string): number {
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

// Minimal left-rotation steps to reach the target index from the current one.
export function leftRotationSteps(currentIndex: number, targetIndex: number): number {
  return (targetIndex - (((currentIndex % 4) + 4) % 4) + 4) % 4
}

export async function harmonyRotate(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  instanceName: string,
  currentIndex: number,
  targetIndex: number
): Promise<number> {
  const steps = leftRotationSteps(currentIndex, targetIndex)
  for (let i = 0; i < steps; i++) {
    ensureHarmonyOk(
      await runner(sdk.emulator, ['-instance', instanceName, '-rotation', 'left']),
      'emulator rotate'
    )
  }
  return targetIndex
}

// hdc shell concatenates its args, so the text is double-quoted to survive
// spaces and shell metacharacters on the device side.
function quoteShellArg(text: string): string {
  return `"${text.replace(/[\\$"`\n\r]/g, '\\$&')}"`
}
