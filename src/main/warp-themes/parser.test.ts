import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWarpThemeYaml } from './parser'

const VALID_THEME = `
name: Tokyo Night
accent: '#7aa2f7'
background: '#1a1b26'
foreground: '#c0caf5'
cursor: '#c0caf5'
details: darker
terminal_colors:
  normal:
    black: '#15161e'
    red: '#f7768e'
    green: '#9ece6a'
    yellow: '#e0af68'
    blue: '#7aa2f7'
    magenta: '#bb9af7'
    cyan: '#7dcfff'
    white: '#a9b1d6'
  bright:
    black: '#414868'
    red: '#f7768e'
    green: '#9ece6a'
    yellow: '#e0af68'
    blue: '#7aa2f7'
    magenta: '#bb9af7'
    cyan: '#7dcfff'
    white: '#c0caf5'
`

describe('parseWarpThemeYaml', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps Warp normal and bright palettes to Orca terminal colors', () => {
    const result = parseWarpThemeYaml(VALID_THEME, 'tokyo_night.yaml', {
      importedAt: '2026-06-05T00:00:00.000Z',
      sourceLabel: 'themes'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.theme).toMatchObject({
      id: 'warp:tokyo-night',
      selectionValue: 'custom:warp:tokyo-night',
      name: 'Tokyo Night',
      source: 'warp',
      mode: 'dark',
      importedAt: '2026-06-05T00:00:00.000Z',
      sourceLabel: 'themes'
    })
    expect(result.theme.terminal).toMatchObject({
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      black: '#15161e',
      red: '#f7768e',
      brightBlack: '#414868',
      brightWhite: '#c0caf5'
    })
  })

  it('derives name from filename and light mode from background luminance', () => {
    const result = parseWarpThemeYaml(
      VALID_THEME.replace('name: Tokyo Night', '').replace(
        "background: '#1a1b26'",
        "background: '#ffffff'"
      ),
      'bright-theme.yaml'
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.theme.name).toBe('bright-theme')
      expect(result.theme.mode).toBe('light')
    }
  })

  it('reports unsupported background images and gradients', () => {
    const result = parseWarpThemeYaml(
      `${VALID_THEME}\nbackground_image:\n  path: ./image.png\nbackground_gradient: []\n`,
      'image.yaml'
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.theme.unsupportedFeatures).toEqual([
        'background image not supported',
        'gradient not supported'
      ])
    }
  })

  it('uses a gradient endpoint as the terminal background', () => {
    const result = parseWarpThemeYaml(
      VALID_THEME.replace(
        "background: '#1a1b26'",
        'background:\n  top: "#002633"\n  bottom: "#000000"'
      ).replace("accent: '#7aa2f7'", 'accent:\n  left: "#007972"\n  right: "#7b008f"'),
      'cyber-wave.yaml'
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.theme.terminal.background).toBe('#002633')
      expect(result.theme.unsupportedFeatures).toEqual([
        'background gradient not supported',
        'accent gradient not supported'
      ])
    }
  })

  it('rejects non-object or unusable themes', () => {
    expect(parseWarpThemeYaml('- one\n- two', 'list.yaml')).toEqual({
      ok: false,
      reason: 'Theme file must contain a YAML object.'
    })
    const partial = parseWarpThemeYaml(
      'background: "#000000"\nforeground: "#ffffff"',
      'partial.yaml'
    )
    expect(partial.ok).toBe(false)
  })

  it('rejects themes that exceed the parse-time budget', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(2_000)

    expect(parseWarpThemeYaml(VALID_THEME, 'slow.yaml')).toEqual({
      ok: false,
      reason: 'Theme file took too long to parse.'
    })
  })
})
