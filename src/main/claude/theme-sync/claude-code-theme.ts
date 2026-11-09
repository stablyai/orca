import type { ITheme } from '@xterm/xterm'
import {
  contrastRatio,
  mix,
  over,
  readableOn,
  rgbaToHex,
  type Rgba
} from '../../../shared/color/rgba-contrast'
import { terminalPaletteRgba } from '../../../shared/terminal-themes/terminal-palette-rgba'
import {
  isTerminalBackgroundLight,
  parseTerminalColor
} from '../../../shared/terminal-themes/terminal-title-contrast'

/** Claude Code's custom theme file: a built-in base plus color overrides, keyed by its own color names. */
export type ClaudeCodeTheme = {
  name: string
  /** One of Claude Code's built-in theme names. */
  base: string
  overrides: Record<string, string>
}

const MIN_TEXT_CONTRAST = 4.5
// Why 3:1: hues only tint status words and borders, the same floor Orca's own theme gate uses.
const MIN_HUE_CONTRAST = 3

/** Claude Code colors from the terminal palette Orca paints, so Claude's own UI matches its pane. */
export function claudeCodeThemeFromTerminal(palette: ITheme | null): ClaudeCodeTheme | null {
  const colors = terminalPaletteRgba(palette, parseTerminalColor)
  if (!palette || !colors) {
    return null
  }
  const { background, foreground, color } = colors
  const light = isTerminalBackgroundLight(palette.background)
  const tint = (hue: Rgba | null, percent: number): Rgba | null =>
    hue && mix(hue, background, percent)
  const surfaces = {
    diffAdded: tint(color('green'), 15),
    diffRemoved: tint(color('red'), 15),
    diffAddedDimmed: tint(color('green'), 8),
    diffRemovedDimmed: tint(color('red'), 8),
    diffAddedWord: tint(color('green'), 32),
    diffRemovedWord: tint(color('red'), 32),
    userMessageBackground: mix(foreground, background, 6),
    userMessageBackgroundHover: mix(foreground, background, 10),
    bashMessageBackgroundColor: mix(foreground, background, 6),
    memoryBackgroundColor: mix(foreground, background, 6),
    rate_limit_empty: mix(foreground, background, 20)
  }
  const textSurfaces = [background, ...Object.values(surfaces).filter((value) => value !== null)]
  const text = readableOn(foreground, textSurfaces, light, MIN_TEXT_CONTRAST)
  const readable = (value: Rgba | null | undefined, minimum = MIN_HUE_CONTRAST): Rgba | null =>
    value ? readableOn(value, [background], light, minimum) : null
  const accent = readable(colors.accent)
  const shimmer = (value: Rgba | null): Rgba | null => value && readable(mix(text, value, 35))
  const yellow = readable(color('yellow'))
  const blue = readable(color('blue'))
  const cyan = readable(color('cyan'))
  const selectionColor = parseTerminalColor(palette.selectionBackground)
  const selection = selectionColor && over(selectionColor, background)
  const overrides: Record<string, Rgba | null> = {
    claude: accent,
    claudeShimmer: shimmer(accent),
    promptBorder: accent,
    promptBorderShimmer: shimmer(accent),
    rate_limit_fill: accent,
    briefLabelClaude: accent,
    permission: blue,
    permissionShimmer: shimmer(blue),
    suggestion: cyan,
    planMode: cyan,
    ide: readable(color('brightCyan')),
    remember: yellow,
    warning: yellow,
    warningShimmer: shimmer(yellow),
    autoAccept: yellow,
    briefLabelYou: yellow,
    success: readable(color('green')),
    error: readable(color('red')),
    merged: readable(color('magenta')),
    bashBorder: readable(color('brightMagenta')),
    text,
    inverseText: background,
    inactive: readable(mix(foreground, background, 60), MIN_TEXT_CONTRAST),
    inactiveShimmer: readable(mix(foreground, background, 75), MIN_TEXT_CONTRAST),
    subtle: readable(mix(foreground, background, 35)),
    ...surfaces,
    // Selected text keeps Claude's own highlight when the palette's would hide it.
    selectionBg: selection && contrastRatio(text, selection) >= MIN_TEXT_CONTRAST ? selection : null
  }
  return {
    name: 'Orca',
    base: light ? 'light' : 'dark',
    overrides: Object.fromEntries(
      Object.entries(overrides).flatMap(([key, value]) =>
        value ? [[key, rgbaToHex(value)] as const] : []
      )
    )
  }
}
