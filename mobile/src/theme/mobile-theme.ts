// Desktop's main.css tokens per scheme; keep mobile on these instead of introducing inline colors.

export type MobileColorScheme = 'light' | 'dark'

const darkColors = {
  // --background, --sidebar, --secondary, --border
  bgBase: '#0a0a0a',
  bgPanel: '#171717',
  bgRaised: '#262626',
  borderSubtle: 'rgba(255, 255, 255, 0.07)',
  editorSurface: '#1e1e1e',
  // --chat-composer-surface painted over --chat-canvas, and --chat-composer-border.
  composerSurface: '#1f1f1f',
  composerBorder: 'rgba(250, 250, 250, 0.09)',
  composerControl: '#262626',
  skillToken: '#8ab4f8',
  skillTokenSurface: 'rgba(59, 130, 246, 0.2)',
  // Your own message: --chat-user-surface and --chat-user-border over --chat-canvas, text in --chat-foreground-strong.
  chatUserSurface: '#262626',
  chatUserBorder: 'rgba(250, 250, 250, 0.06)',
  chatForegroundStrong: '#e3e3e3',

  // --foreground, --muted-foreground, --chat-foreground-faint
  textPrimary: '#fafafa',
  textSecondary: '#a1a1a1',
  textMuted: '#898989',

  // --primary: the filled primary-action surface.
  surfaceBright: '#e5e5e5',

  accentBlue: '#3b82f6',
  // White text preserves contrast on saturated accent fills.
  onAccent: '#ffffff',

  // --status-success, --status-warning, --destructive
  statusGreen: '#86efac',
  statusAmber: '#eab308',
  statusRed: '#ff6568',
  // Match desktop’s merge CTA fill and text.
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  // Desktop's merged-PR purple (`dark:text-purple-300`).
  statusPurple: '#d8b4fe',
  gitDecorationAdded: '#81b88b',
  gitDecorationDeleted: '#c74e39',
  // Desktop's `--diff-*-ground` and `--diff-*-gutter` mixes.
  diffAddedBg: 'rgba(129, 184, 139, 0.16)',
  diffDeletedBg: 'rgba(199, 78, 57, 0.18)',
  diffAddedGutter: 'rgba(129, 184, 139, 0.3)',
  diffDeletedGutter: 'rgba(199, 78, 57, 0.32)',
  // Desktop's `--chat-diff-*`: decoration mixed toward foreground for tinted rows.
  chatDiffAdded: '#a5ccac',
  chatDiffRemoved: '#d68273',

  // Monaco's `vs-dark`; function and meta come from VS Code Dark+, which Monaco lacks.
  syntaxComment: '#608b4e',
  syntaxKeyword: '#569cd6',
  syntaxString: '#ce9178',
  syntaxNumber: '#b5cea8',
  syntaxType: '#3dc9b0',
  syntaxFunction: '#dcdcaa',
  syntaxVariable: '#74b0df',
  syntaxMeta: '#c586c0',

  // Terminal WebView background (Tokyonight) — separate from app chrome
  terminalBg: '#1a1b26'
}

export type MobilePalette = { readonly [K in keyof typeof darkColors]: string }

const lightColors: MobilePalette = {
  bgBase: '#ffffff',
  bgPanel: '#fafafa',
  bgRaised: '#f5f5f5',
  borderSubtle: '#e5e5e5',
  editorSurface: '#ffffff',
  composerSurface: '#ffffff',
  composerBorder: 'rgba(10, 10, 10, 0.11)',
  composerControl: '#f5f5f5',
  skillToken: '#1d4ed8',
  skillTokenSurface: 'rgba(59, 130, 246, 0.12)',
  chatUserSurface: '#f5f5f5',
  chatUserBorder: 'rgba(10, 10, 10, 0.07)',
  chatForegroundStrong: '#1e1e1e',

  textPrimary: '#0a0a0a',
  textSecondary: '#737373',
  textMuted: '#737373',

  surfaceBright: '#171717',

  accentBlue: '#2563eb',
  onAccent: '#ffffff',

  statusGreen: '#15803d',
  statusAmber: '#ca8a04',
  statusRed: '#e40014',
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  statusPurple: '#9333ea',
  gitDecorationAdded: '#587c0c',
  gitDecorationDeleted: '#ad0707',
  diffAddedBg: 'rgba(88, 124, 12, 0.13)',
  diffDeletedBg: 'rgba(173, 7, 7, 0.11)',
  diffAddedGutter: 'rgba(88, 124, 12, 0.26)',
  diffDeletedGutter: 'rgba(173, 7, 7, 0.22)',
  chatDiffAdded: '#415a0b',
  chatDiffRemoved: '#7c0808',

  // Monaco's `vs`; function and meta from VS Code Light+.
  syntaxComment: '#008000',
  syntaxKeyword: '#0000ff',
  syntaxString: '#a31515',
  syntaxNumber: '#098658',
  syntaxType: '#008080',
  syntaxFunction: '#795e26',
  syntaxVariable: '#001188',
  syntaxMeta: '#af00db',

  terminalBg: '#1a1b26'
}

const palettes: Record<MobileColorScheme, MobilePalette> = { dark: darkColors, light: lightColors }

export function paletteForScheme(scheme: MobileColorScheme): MobilePalette {
  return palettes[scheme]
}

// Live object rewritten in place on a scheme change; read it at render time, never copy at module scope.
export const colors: MobilePalette = { ...darkColors }

let currentScheme: MobileColorScheme = 'dark'
const schemeListeners = new Set<() => void>()

export function getMobileColorScheme(): MobileColorScheme {
  return currentScheme
}

export function applyMobileColorScheme(scheme: MobileColorScheme): void {
  if (scheme === currentScheme) {
    return
  }
  currentScheme = scheme
  Object.assign(colors, palettes[scheme])
  for (const listener of schemeListeners) {
    listener()
  }
}

export function subscribeMobileColorScheme(listener: () => void): () => void {
  schemeListeners.add(listener)
  return () => {
    schemeListeners.delete(listener)
  }
}

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
  composerItem: 12
} as const

export const typography = {
  titleSize: 18,
  bodySize: 14,
  metaSize: 12,
  monoFamily: 'monospace' as const
} as const
