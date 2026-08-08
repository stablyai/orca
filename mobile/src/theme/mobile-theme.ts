// Orca mobile design tokens — matches desktop graphite/dark palette.
// All screen files should import from here instead of using inline hex values.

// Why: the shared token contract. Both palettes are typed against this so they
// must carry the same keys, and a value stays a plain `string` (not a literal)
// so the light palette can hold different hexes for the same key.
export type ThemeColors = {
  bgBase: string
  bgPanel: string
  bgRaised: string
  borderSubtle: string
  editorSurface: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  surfaceBright: string
  accentBlue: string
  onAccent: string
  statusGreen: string
  statusAmber: string
  statusRed: string
  mergeGreen: string
  onMergeGreen: string
  statusPurple: string
  gitDecorationAdded: string
  gitDecorationDeleted: string
  diffAddedBg: string
  diffDeletedBg: string
  syntaxComment: string
  syntaxKeyword: string
  syntaxString: string
  syntaxNumber: string
  syntaxType: string
  syntaxFunction: string
  syntaxVariable: string
  syntaxMeta: string
  terminalBg: string
}

// Why: the dark palette is the original (and still the default fallback for
// screens not yet migrated to the theme context). `darkColors` and
// `lightColors` share the exact same token keys so a screen can swap the whole
// object via `useThemeColors()` without touching any individual reference.
export const darkColors: ThemeColors = {
  bgBase: '#111111',
  bgPanel: '#1a1a1a',
  bgRaised: '#242424',
  borderSubtle: '#2a2a2a',
  editorSurface: '#1e1e1e',

  textPrimary: '#e0e0e0',
  textSecondary: '#a1a1a1',
  textMuted: '#8c8c8c',

  // Crisp near-white surface for the single primary action on a screen (the
  // worktree FAB). Brighter than textPrimary so it reads as a solid button, not
  // disabled chrome, while staying monochrome (STYLEGUIDE: color is for state).
  surfaceBright: '#f5f5f5',

  accentBlue: '#3b82f6',
  // Text/icon color on a filled accent (accentBlue) button, where the muted
  // textPrimary would lack contrast against the saturated fill.
  onAccent: '#ffffff',

  statusGreen: '#22c55e',
  statusAmber: '#f59e0b',
  statusRed: '#ef4444',
  // Merge CTA fill + its on-fill text, mirroring the desktop ChecksPanel's
  // bg-green-600 "Squash and merge" button (green-600 / white).
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  // Merged-PR purple, mirroring the desktop ReviewIcon's purple-400/70 tone.
  statusPurple: '#a78bfa',
  gitDecorationAdded: '#81b88b',
  gitDecorationDeleted: '#c74e39',
  diffAddedBg: 'rgba(129, 184, 139, 0.1)',
  diffDeletedBg: 'rgba(199, 78, 57, 0.11)',

  syntaxComment: '#6a9955',
  syntaxKeyword: '#569cd6',
  syntaxString: '#ce9178',
  syntaxNumber: '#b5cea8',
  syntaxType: '#4ec9b0',
  syntaxFunction: '#dcdcaa',
  syntaxVariable: '#9cdcfe',
  syntaxMeta: '#c586c0',

  // Terminal WebView background (Tokyonight) — separate from app chrome
  terminalBg: '#1a1b26'
}

// Why: light counterpart with the same token keys. Surfaces ascend from a soft
// off-white base to crisp white raised cards (mirroring the dark palette's
// dark→lighter progression), with text inverted to near-black on white and
// borders darkened for contrast. Accent/status hues are nudged a touch deeper
// so they keep AA contrast on light fills; syntax + terminal tokens keep their
// dark-optimized values because the terminal WebView and code surfaces stay
// dark regardless of app chrome.
export const lightColors: ThemeColors = {
  bgBase: '#f7f7f8',
  bgPanel: '#ffffff',
  bgRaised: '#eef0f2',
  borderSubtle: '#e2e4e8',
  editorSurface: '#ffffff',

  textPrimary: '#1a1a1a',
  textSecondary: '#5c6066',
  textMuted: '#9a9ea4',

  // Light-mode inversion of the dark palette's near-white surfaceBright: still
  // the monochrome, high-contrast primary-action surface, just flipped to a
  // near-black fill so it reads as solid against the light canvas.
  surfaceBright: '#1a1a1a',

  accentBlue: '#2563eb',
  onAccent: '#ffffff',

  statusGreen: '#16a34a',
  statusAmber: '#d97706',
  statusRed: '#dc2626',
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  statusPurple: '#7c3aed',
  gitDecorationAdded: '#3a7d44',
  gitDecorationDeleted: '#b03a28',
  diffAddedBg: 'rgba(58, 125, 68, 0.1)',
  diffDeletedBg: 'rgba(176, 58, 40, 0.1)',

  // Syntax + terminal tokens stay on the dark-optimized values: the code/diff
  // surfaces and the terminal WebView remain dark even in light app chrome.
  syntaxComment: '#6a9955',
  syntaxKeyword: '#569cd6',
  syntaxString: '#ce9178',
  syntaxNumber: '#b5cea8',
  syntaxType: '#4ec9b0',
  syntaxFunction: '#dcdcaa',
  syntaxVariable: '#9cdcfe',
  syntaxMeta: '#c586c0',

  terminalBg: '#1a1b26'
}

// Why: kept as the dark palette so screens not yet migrated to the theme
// context still compile and render dark (the clean dark fallback the AC
// allows). Migrated screens read the active palette via `useThemeColors()`.
export const colors = darkColors

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
