// Omit maxTouchPoints when disabling: Chromium rejects 0 even then (#22749).
const TOUCH_EMULATION_DISABLED = { enabled: false } as const
const TOUCH_EMULATION_MOBILE = { enabled: true, maxTouchPoints: 5 } as const

export function touchEmulationParams(mobile: boolean) {
  return mobile ? TOUCH_EMULATION_MOBILE : TOUCH_EMULATION_DISABLED
}
