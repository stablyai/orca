import { colors, getMobileColorScheme } from '../../theme/mobile-theme'

export function richMarkdownEditorThemeProperties(): Record<string, string> {
  return {
    'color-scheme': getMobileColorScheme(),
    '--background': colors.bgBase,
    '--editor-surface': colors.bgBase,
    '--foreground': colors.textPrimary,
    '--muted-foreground': colors.textSecondary,
    '--muted': colors.bgRaised,
    '--border': colors.borderSubtle,
    '--primary': colors.textPrimary,
    '--primary-foreground': colors.bgBase,
    '--accent-link': colors.accentBlue
  }
}

/** Change presentation in place: the draft, selection and document stay mounted. */
export function applyRichMarkdownEditorTheme(root: HTMLElement): void {
  for (const [key, value] of Object.entries(richMarkdownEditorThemeProperties())) {
    root.style.setProperty(key, value)
  }
}
