import { EmulatorError } from '../emulator-errors'

export type DeviceScreenSize = { width: number; height: number }

// Input uses normalized coordinates, while the last addressable device pixel is dimension - 1.
function toPixel(normalized: number, dimension: number): number {
  const rounded = Math.round(normalized * dimension)
  const max = dimension - 1
  if (rounded < 0) {
    return 0
  }
  if (rounded > max) {
    return max
  }
  return rounded
}

export function normalizedToDevicePixels(
  x: number,
  y: number,
  size: DeviceScreenSize
): { x: number; y: number } {
  return {
    x: toPixel(x, size.width),
    y: toPixel(y, size.height)
  }
}

// Android KeyEvent KEYCODE_* values, including the common aliases agents use.
const BUTTON_KEYCODES: Record<string, number> = {
  home: 3,
  back: 4,
  recents: 187,
  app_switch: 187,
  recent: 187,
  overview: 187,
  power: 26,
  lock: 26,
  volume_up: 24,
  volup: 24,
  volume_down: 25,
  voldown: 25
}

export function androidButtonKeycode(name: string): number {
  const keycode = BUTTON_KEYCODES[name]
  if (keycode === undefined) {
    throw new EmulatorError('emulator_error', `Unknown Android hardware button: ${name}`)
  }
  return keycode
}
