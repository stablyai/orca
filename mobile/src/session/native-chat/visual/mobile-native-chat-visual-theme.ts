import type { NativeChatVisualTheme } from '../../../../../src/shared/native-chat/visuals/native-chat-visual-shell'
import { paletteForScheme, radii, type MobileColorScheme } from '../../../theme/mobile-theme'

// Match desktop’s chart tokens; initialize visual styles before author content runs.
export function mobileNativeChatVisualTheme(colorScheme: MobileColorScheme): NativeChatVisualTheme {
  const colors = paletteForScheme(colorScheme)
  return {
    colorScheme,
    tokens: {
      '--background': colors.bgBase,
      '--foreground': colors.textPrimary,
      '--card': colors.bgPanel,
      '--card-foreground': colors.textPrimary,
      '--popover': colors.bgRaised,
      '--popover-foreground': colors.textPrimary,
      '--primary': colors.surfaceBright,
      '--primary-foreground': colors.bgBase,
      '--secondary': colors.bgRaised,
      '--secondary-foreground': colors.textPrimary,
      '--muted': colors.bgRaised,
      '--muted-foreground': colors.textSecondary,
      '--accent': colors.bgRaised,
      '--accent-foreground': colors.textPrimary,
      '--destructive': colors.statusRed,
      '--destructive-foreground': colors.onStatusRed,
      '--border': colors.borderSubtle,
      '--input': colors.borderSubtle,
      '--ring': colors.textMuted,
      '--radius': `${radii.tile}px`,
      '--chart-1': '#8ec5ff',
      '--chart-2': '#2b7fff',
      '--chart-3': '#155dfc',
      '--chart-4': '#1447e6',
      '--chart-5': '#193cb8',
      '--font-sans': '-apple-system, system-ui, Roboto, sans-serif',
      '--font-mono': 'Menlo, monospace'
    }
  }
}
