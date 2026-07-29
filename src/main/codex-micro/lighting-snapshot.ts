type LightingInput = {
  enabled: boolean
  brightness: number
  ambientColor?: number
  keyColor?: number
}

type WireLight = {
  e: 0 | 1
  b: number
  s: 0
  m: 0
  c: string
}

type WireSlot = {
  id: number
  c: string
  b: number
  e: 0 | 1
  s: 0
  sk: 0
  sa: 0
}

export type CodexMicroLightingSnapshot = {
  rgbcfg: { ambient: WireLight; keys: WireLight }
  thstatus: WireSlot[]
}

export function parseCodexMicroLightingSnapshot(value: unknown): CodexMicroLightingSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ['rgbcfg', 'thstatus'])) {
    return null
  }
  const rgbcfg = value.rgbcfg
  const thstatus = value.thstatus
  if (
    !isRecord(rgbcfg) ||
    !hasExactKeys(rgbcfg, ['ambient', 'keys']) ||
    !isWireLight(rgbcfg.ambient) ||
    !isWireLight(rgbcfg.keys) ||
    !Array.isArray(thstatus) ||
    thstatus.length !== 6 ||
    !thstatus.every((slot, id) => isWireSlot(slot, id))
  ) {
    return null
  }
  return value as CodexMicroLightingSnapshot
}

export function buildCodexMicroLightingSnapshot(input: LightingInput): CodexMicroLightingSnapshot {
  const enabled = input.enabled ? 1 : 0
  const brightness = input.enabled ? clamp(input.brightness, 0, 100) / 100 : 0
  const ambientColor = input.enabled ? colorToWire(input.ambientColor ?? 0xffffff) : '0x000000'
  const keyColor = input.enabled ? colorToWire(input.keyColor ?? 0xffffff) : '0x000000'
  const light = (c: string): WireLight => ({ e: enabled, b: brightness, s: 0, m: 0, c })

  return {
    rgbcfg: {
      ambient: light(ambientColor),
      keys: light(keyColor)
    },
    thstatus: Array.from({ length: 6 }, (_, id) => ({
      id,
      c: keyColor,
      b: brightness,
      e: enabled,
      s: 0,
      sk: 0,
      sa: 0
    }))
  }
}

function colorToWire(value: number): string {
  return `0x${clamp(value, 0, 0xffffff).toString(16).padStart(6, '0')}`
}

function clamp(value: number, min: number, max: number): number {
  const finite = Number.isFinite(value) ? Math.round(value) : min
  return Math.min(max, Math.max(min, finite))
}

function isWireLight(value: unknown): value is WireLight {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['e', 'b', 's', 'm', 'c']) &&
    isBinary(value.e) &&
    isBrightness(value.b) &&
    value.s === 0 &&
    value.m === 0 &&
    isWireColor(value.c)
  )
}

function isWireSlot(value: unknown, expectedId: number): value is WireSlot {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'c', 'b', 'e', 's', 'sk', 'sa']) &&
    value.id === expectedId &&
    isWireColor(value.c) &&
    isBrightness(value.b) &&
    isBinary(value.e) &&
    value.s === 0 &&
    value.sk === 0 &&
    value.sa === 0
  )
}

function isBinary(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1
}

function isBrightness(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isWireColor(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{6}$/.test(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
