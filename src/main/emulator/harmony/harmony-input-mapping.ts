import { EmulatorError } from '../emulator-errors'

export type DeviceScreenSize = { width: number; height: number }

// Normalized 0..1 (top-left origin) -> integer device pixels, clamped to
// [0, dimension-1] (the max addressable pixel).
export function normalizedToDevicePixels(
  x: number,
  y: number,
  size: DeviceScreenSize
): { x: number; y: number } {
  return { x: toPixel(x, size.width), y: toPixel(y, size.height) }
}

function toPixel(normalized: number, dimension: number): number {
  const rounded = Math.round(normalized * dimension)
  if (rounded < 0) {
    return 0
  }
  if (rounded > dimension - 1) {
    return dimension - 1
  }
  return rounded
}

// OpenHarmony KeyCode values (oh_key_code.h), with the common aliases agents use.
const BUTTON_KEYCODES: Record<string, number> = {
  home: 1,
  back: 2,
  recents: 2210,
  app_switch: 2210,
  recent: 2210,
  overview: 2210,
  multitask: 2210,
  power: 18,
  lock: 18,
  volume_up: 16,
  volup: 16,
  volume_down: 17,
  voldown: 17
}

export function harmonyButtonKeycode(name: string): number {
  const keycode = BUTTON_KEYCODES[name]
  if (keycode === undefined) {
    throw new EmulatorError('emulator_error', `Unknown HarmonyOS hardware button: ${name}`)
  }
  return keycode
}
