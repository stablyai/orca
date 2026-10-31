/** sRGB channels 0-255 and alpha 0-1. */
export type Rgba = [number, number, number, number]

/** VS Code theme colors are hex: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. */
export function parseHex(value: unknown): Rgba | null {
  if (typeof value !== 'string') {
    return null
  }
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim())?.[1]
  if (!hex) {
    return null
  }
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex
  const channel = (index: number): number => Number.parseInt(full.slice(index, index + 2), 16)
  return [channel(0), channel(2), channel(4), full.length === 8 ? channel(6) / 255 : 1]
}

export function toHex([r, g, b, a]: Rgba): string {
  const byte = (value: number): string => Math.round(value).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ''}`
}

/** Paints a translucent color onto an opaque one, as VS Code shows it. */
export function flatten(color: Rgba, under: Rgba): Rgba {
  const [r, g, b, a] = color
  return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1]
}

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio of two opaque colors. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

export function isLightColor(color: Rgba): boolean {
  return luminance(color) > 0.4
}
