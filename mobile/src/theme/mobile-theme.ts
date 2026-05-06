// Orca mobile design tokens — matches desktop graphite/dark palette.
// All screen files should import from here instead of using inline hex values.

export const colors = {
  bgBase: '#111111',
  bgPanel: '#1a1a1a',
  bgRaised: '#242424',
  borderSubtle: '#2a2a2a',

  textPrimary: '#e0e0e0',
  textSecondary: '#888888',
  textMuted: '#555555',

  accentBlue: '#3b82f6',

  statusGreen: '#22c55e',
  statusAmber: '#f59e0b',
  statusRed: '#ef4444',

  // Terminal WebView background (Tokyonight) — separate from app chrome
  terminalBg: '#1a1b26'
} as const

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
