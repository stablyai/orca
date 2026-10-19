import type { NativeChatVisualTheme } from '../../../src/shared/native-chat-visual-shell'
import { colors, radii } from '../theme/mobile-theme'

/**
 * The phone's one (dark) theme, as the variables a visual styles against. The app has no theme
 * switch, so a visual receives this before its content runs and never needs a live update.
 * Chart colors are desktop's dark `--chart-1..5` (the blue 300-800 ramp), as hex.
 */
export const MOBILE_NATIVE_CHAT_VISUAL_THEME: NativeChatVisualTheme = {
  colorScheme: 'dark',
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
    '--muted-foreground': colors.textMuted,
    '--accent': colors.bgRaised,
    '--accent-foreground': colors.textPrimary,
    '--destructive': colors.statusRed,
    '--destructive-foreground': colors.onAccent,
    '--border': colors.borderSubtle,
    '--input': colors.borderSubtle,
    '--ring': colors.textMuted,
    '--radius': `${radii.row}px`,
    '--chart-1': '#8ec5ff',
    '--chart-2': '#2b7fff',
    '--chart-3': '#155dfc',
    '--chart-4': '#1447e6',
    '--chart-5': '#193cb8',
    '--font-sans': '-apple-system, system-ui, Roboto, sans-serif',
    '--font-mono': 'Menlo, monospace'
  }
}
