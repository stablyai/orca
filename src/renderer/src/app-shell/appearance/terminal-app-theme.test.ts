import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ColorProbe } from './plugin-theme-tokens'
import { contrastRatio, over } from '../../../../shared/color/rgba-contrast'
import { synthesizeTerminalAppTheme } from './terminal-app-theme'

// Parses #rrggbb and rgb(r g b), which is all the synthesized theme and its inputs use.
const probe: ColorProbe = (value) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1]
  if (hex) {
    const channel = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16)
    return [channel(0), channel(2), channel(4), 1]
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(value.trim())
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), 1] : null
}

function settingsWith(overrides: Partial<GlobalSettings>): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), theme: 'dark', ...overrides }
}

describe('synthesizeTerminalAppTheme', () => {
  it('keeps the host pill label legible on its accent fill in light and dark', () => {
    for (const [terminalThemeDark, tint] of [
      ['GitHub Light', 1],
      ['Nord', 0.8]
    ] as const) {
      const tokens = synthesizeTerminalAppTheme(
        settingsWith({ terminalThemeDark }),
        true,
        probe
      )?.tokens
      const color = (token: string) => probe(tokens?.[token] ?? '') ?? [0, 0, 0, 1]
      const [r, g, b] = color('--accent')
      const pill = over([r, g, b, tint], color('--sidebar'))
      expect(contrastRatio(color('--muted-foreground'), pill)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
