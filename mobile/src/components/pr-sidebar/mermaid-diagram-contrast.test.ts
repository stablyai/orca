// @vitest-environment happy-dom
import mermaid from 'mermaid'
import { afterEach, expect, it } from 'vitest'
import { MERMAID_DIAGRAM_CONFIG } from './mermaid-diagram-config'
import { applyMobileColorScheme } from '../../theme/mobile-theme'

afterEach(() => applyMobileColorScheme('dark'))
function luminance(value: unknown): number {
  if (typeof value !== 'string') {
    throw new Error('Expected a resolved diagram color')
  }
  const color = value === 'lightgrey' ? '#d3d3d3' : value
  if (!/^#[\da-f]{6}$/i.test(color)) {
    throw new Error(`Unsupported color: ${color}`)
  }
  const linear = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}
it.each(['dark', 'light'] as const)('keeps ER and Gantt text readable in %s mode', (scheme) => {
  applyMobileColorScheme(scheme)
  mermaid.initialize(MERMAID_DIAGRAM_CONFIG)
  const variables = mermaid.mermaidAPI.getConfig().themeVariables
  if (!variables) {
    throw new Error('Mermaid did not resolve the theme')
  }
  for (const [foreground, background] of [
    ['textColor', 'attributeBackgroundColorOdd'],
    ['textColor', 'attributeBackgroundColorEven'],
    ['taskTextDarkColor', 'doneTaskBkgColor'],
    ['taskTextDarkColor', 'activeTaskBkgColor']
  ]) {
    const a = luminance(variables[foreground!]),
      b = luminance(variables[background!])
    expect(
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      `${foreground} on ${background}`
    ).toBeGreaterThanOrEqual(4.5)
  }
})
