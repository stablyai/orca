// Orca mobile design tokens — matches desktop graphite/dark palette.
// All screen files should import from here instead of using inline hex values.

import { darkColors } from './mobile-dark-colors'
export { darkColors } from './mobile-dark-colors'

export type MobileColorScheme = 'light' | 'dark'
export type MobileColors = { [Key in keyof typeof darkColors]: string }

// Light surfaces follow the desktop neutral palette; status and syntax tones stay readable.
export const lightColors: MobileColors = {
  ...darkColors,
  bgBase: '#ffffff',
  bgPanel: '#fafafa',
  bgRaised: '#f5f5f5',
  borderSubtle: '#e5e5e5',
  editorSurface: '#ffffff',
  textPrimary: '#171717',
  textSecondary: '#525252',
  textMuted: '#6b6b6b',
  surfaceBright: '#171717',
  accentBlue: '#2563eb',
  statusGreen: '#15803d',
  statusAmber: '#a16207',
  statusRed: '#b91c1c',
  mergeGreen: '#15803d',
  statusPurple: '#7e22ce',
  agentWorking: '#a16207',
  agentDone: '#15803d',
  agentAttention: '#b91c1c',
  agentInactive: '#6b6b6b',
  gitDecorationAdded: '#22863a',
  gitDecorationDeleted: '#b91c1c',
  diffAddedBg: 'rgba(34, 134, 58, 0.1)',
  diffDeletedBg: 'rgba(185, 28, 28, 0.08)',
  syntaxComment: '#008000',
  syntaxKeyword: '#0000ff',
  syntaxString: '#a31515',
  syntaxNumber: '#098658',
  syntaxType: '#267f99',
  syntaxFunction: '#795e26',
  syntaxVariable: '#001080',
  syntaxMeta: '#af00db'
}

let colorScheme: MobileColorScheme = 'dark'
export let colors: MobileColors = darkColors
const themeListeners = new Set<() => void>()
export const getMobileColorScheme = (): MobileColorScheme => colorScheme
export function subscribeMobileTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  return () => {
    themeListeners.delete(listener)
  }
}
export function applyMobileColorScheme(next: MobileColorScheme): void {
  if (next === colorScheme) {
    return
  }
  colorScheme = next
  onBrightColors =
    next === 'light'
      ? {
          secondary: darkColors.textSecondary,
          link: darkColors.accentBlue,
          codeBackground: darkColors.bgRaised
        }
      : darkOnBrightColors
  colors = next === 'light' ? lightColors : darkColors
  for (const listener of themeListeners) {
    listener()
  }
}

/** On your own message's fill (`colors.textPrimary`), where the dark palette's light text would
 *  vanish; its body text is `colors.bgBase`. */
const darkOnBrightColors = {
  secondary: '#4a4a4a',
  link: '#1e40af',
  codeBackground: '#c8c8c8'
} as const
export let onBrightColors: { secondary: string; link: string; codeBackground: string } =
  darkOnBrightColors

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24
} as const

export const radii = {
  row: 6,
  card: 14,
  button: 6,
  input: 6,
  camera: 8
} as const

export const typography = {
  titleSize: 18,
  bodySize: 14,
  metaSize: 12,
  monoFamily: 'monospace' as const
} as const
