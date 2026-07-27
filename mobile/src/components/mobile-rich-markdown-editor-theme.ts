import type { ThemeColors } from '../theme/mobile-theme'

/** CSS custom properties the editor shell reads; also the inject payload for theme flips. */
export function mobileRichMarkdownEditorThemeVars(
  colors: ThemeColors
): Readonly<Record<string, string>> {
  return {
    '--background': colors.bgBase,
    '--editor-surface': colors.editorSurface,
    '--foreground': colors.textPrimary,
    '--muted-foreground': colors.textSecondary,
    '--muted': colors.bgRaised,
    '--border': colors.borderSubtle,
    '--primary': colors.textPrimary,
    '--primary-foreground': colors.bgBase,
    '--accent-link': colors.accentBlue
  }
}
