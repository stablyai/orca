import { MIN_TEXT_CONTRAST } from './plugin-theme-contrast-rules'
import { browserColorProbe, paintedThemeColors, type ColorProbe } from './plugin-theme-tokens'
import { contrastRatio, mix, type Rgba } from '../../../../shared/color/rgba-contrast'

export const CHAT_SELECTION_MIX_TOKEN = '--chat-selection-mix'
// Keep in sync with --chat-selection-mix in main.css: about as deep as the system highlight.
export const CHAT_SELECTION_MIX = { light: 30, dark: 40 } as const

// Why a floor: a selection lighter than this is hard to see, which is worse than dim selected text.
const MIN_VISIBLE_MIX = 15

/**
 * How much link hue the chat selection mixes into the chat background: Orca's own depth, lowered
 * (down to a visible floor) to the deepest mix that keeps selected text 4.5:1.
 */
export function chatSelectionMixOver(
  text: Rgba,
  canvas: Rgba,
  hue: Rgba,
  base: 'light' | 'dark'
): number {
  const deepest = CHAT_SELECTION_MIX[base]
  if (text[3] < 1 || canvas[3] < 1 || hue[3] < 1) {
    return deepest
  }
  for (let percent = deepest; percent >= MIN_VISIBLE_MIX; percent--) {
    if (contrastRatio(mix(hue, canvas, percent), text) >= MIN_TEXT_CONTRAST) {
      return percent
    }
  }
  return MIN_VISIBLE_MIX
}

/** chatSelectionMixOver for a theme's tokens, which already passed safePluginThemeTokens. */
export function chatSelectionMix(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): number {
  const effective = paintedThemeColors(tokens, base, builtIns, probe)
  const text = effective('--chat-selection-foreground')
  const canvas = effective('--chat-canvas')
  const hue = effective('--text-link')
  return text && canvas && hue
    ? chatSelectionMixOver(text, canvas, hue, base)
    : CHAT_SELECTION_MIX[base]
}

// Keep in sync with --callout-note in main.css, which follows the chat's own scheme.
const ORCA_LINK_BLUE = { light: '#0969da', dark: '#4493f8' } as const

let lastTerminalMix: { key: string; mix: number } | null = null

/** chatSelectionMixOver for a chat painted in the terminal's colors and scheme. */
export function terminalChatSelectionMix(
  colors: { foreground: string; background: string },
  chatBase: 'light' | 'dark',
  probe: ColorProbe = browserColorProbe
): number {
  // Why cache: every pane recomputes its chat style per width bucket while resizing.
  const key = `${colors.foreground}|${colors.background}|${chatBase}`
  if (lastTerminalMix?.key === key && probe === browserColorProbe) {
    return lastTerminalMix.mix
  }
  const text = probe(colors.foreground)
  const canvas = probe(colors.background)
  const hue = probe(ORCA_LINK_BLUE[chatBase])
  const mixed =
    text && canvas && hue
      ? chatSelectionMixOver(text, canvas, hue, chatBase)
      : CHAT_SELECTION_MIX[chatBase]
  if (probe === browserColorProbe && text && canvas && hue) {
    lastTerminalMix = { key, mix: mixed }
  }
  return mixed
}
