// Orca mobile design tokens — matches desktop graphite/dark palette.
// All screen files should import from here instead of using inline hex values.

export const darkColors = {
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
  // Pressed state for the surfaceBright fill — bg-primary/90 composited over bgBase
  // (src/renderer/src/components/ui/button.tsx:12). Dark keeps the value
  // NewWorkspaceFab already rendered, so this is a rename, not a repaint.
  surfaceBrightPressed: '#e0e0e0',

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
} as const

export type ThemeColors = { readonly [K in keyof typeof darkColors]: string }

export const lightColors: ThemeColors = {
  bgBase: '#ffffff', // --background main.css:133
  bgPanel: '#f5f5f5', // --secondary / --muted :142,144
  bgRaised: '#eaeaea', // --worktree-sidebar-accent :165 (--accent would collapse into bgPanel)
  borderSubtle: '#e5e5e5', // --border :150
  editorSurface: '#ffffff', // --editor-surface :134

  textPrimary: '#0a0a0a', // --foreground :135 (NOT --primary, which is a surface token)
  textSecondary: '#737373', // --muted-foreground :145
  // INVENTED: desktop light has only two text tiers. Lightest neutral that still
  // clears 3:1 on bgBase/bgPanel/bgRaised (3.69/3.38/3.07). Must stay 6-digit hex —
  // MobileAgentIcon.tsx:77 concatenates an alpha suffix onto it.
  textMuted: '#858585',

  surfaceBright: '#171717', // --primary :140 — the single affirmative-action fill; inverts
  surfaceBrightPressed: '#2e2e2e',

  // blue-700: desktop steps its blue accent two ramp stops darker in light
  // (--terminal-pane-locate, main.css:239 -> :153). blue-600 would fail AA on the
  // 12px links that sit on bgRaised (agent-history-styles.ts:152, mobile-markdown-styles.ts:51).
  accentBlue: '#1447e6',
  onAccent: '#ffffff',

  statusGreen: '#15803d', // --status-success :155
  // INVENTED: no desktop status-amber (--annotation-highlight is a fill, 2.15:1 as text on white;
  // --git-decoration-modified is fenced to git status by STYLEGUIDE:60). Tuned to the same
  // ~5:1-on-bgBase weight as statusGreen/statusRed so the trio reads as one family.
  statusAmber: '#b45309',
  statusRed: '#e40014', // --destructive :148
  // Fixed: desktop renders the merge CTA bg-green-600/text-white with no dark: variant.
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  statusPurple: '#7f22fe', // violet-600 — the two-stop step desktop applies to merged-PR purple
  gitDecorationAdded: '#587c0c', // --git-decoration-added :191
  gitDecorationDeleted: '#ad0707', // --git-decoration-deleted :193
  // Alpha re-derived (not copied): the light git colors are much darker, so 0.09
  // reproduces the dark washes' perceived strength instead of doubling it.
  diffAddedBg: 'rgba(88, 124, 12, 0.09)',
  diffDeletedBg: 'rgba(173, 7, 7, 0.09)',

  // VS Code Light+ / Monaco `vs` — the light counterpart of the Dark+ values already in
  // darkColors. Desktop performs the identical swap: isDark ? 'vs-dark' : 'vs'
  // (MonacoEditor.tsx:828 and five sibling files). main.css has no syntax tokens; Monaco owns them.
  syntaxComment: '#008000',
  syntaxKeyword: '#0000ff',
  syntaxString: '#a31515',
  syntaxNumber: '#098658',
  syntaxType: '#267f99',
  syntaxFunction: '#795e26',
  syntaxVariable: '#001080',
  syntaxMeta: '#af00db',

  // Builtin Tango Light background — the desktop default light terminal theme
  // (src/shared/constants.ts:222 -> src/shared/terminal-themes/defaults.ts).
  terminalBg: '#ffffff'
}

// Why: unconverted modules keep compiling and keep rendering dark until the
// themed-styles migration reaches them (see theme/unthemed-color-imports.test.ts).
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
