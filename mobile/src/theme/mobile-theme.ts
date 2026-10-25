// Orca mobile design tokens — matches desktop graphite/dark palette.
// All screen files should import from here instead of using inline hex values.

export const colors = {
  bgBase: '#111111',
  bgPanel: '#1a1a1a',
  bgRaised: '#242424',
  borderSubtle: '#2a2a2a',
  editorSurface: '#1e1e1e',
  // The chat composer: one lifted box whose round controls sit a step above it.
  composerSurface: '#1d1d1d',
  composerBorder: 'rgba(255, 255, 255, 0.08)',
  composerControl: '#2a2a2a',
  // A picked skill inside the composer's text.
  skillToken: '#8ab4f8',
  skillTokenSurface: 'rgba(59, 130, 246, 0.2)',

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
  // Desktop's `--diff-*-gutter`: a tinted row's line-number column.
  diffAddedGutter: 'rgba(129, 184, 139, 0.3)',
  diffDeletedGutter: 'rgba(199, 78, 57, 0.32)',
  // Desktop's `--chat-diff-*`: diff text in the chat, mixed toward the foreground so it reads on a
  // tinted row where the git decoration colours would not.
  chatDiffAdded: '#a5ccac',
  chatDiffRemoved: '#d68273',

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
} as const

/** On your own message's fill (`colors.textPrimary`), where the dark palette's light text would
 *  vanish; its body text is `colors.bgBase`. */
export const onBrightColors = {
  secondary: '#4a4a4a',
  link: '#1e40af',
  codeBackground: '#c8c8c8'
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
  camera: 8,
  composer: 24,
  // Attachment thumbnails and file cards inside the composer.
  composerItem: 12
} as const

export const typography = {
  titleSize: 18,
  bodySize: 14,
  metaSize: 12,
  monoFamily: 'monospace' as const
} as const
