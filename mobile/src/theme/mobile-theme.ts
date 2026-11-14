import { codeFontFamily } from './mobile-code-font'

// Desktop's main.css tokens per scheme; keep mobile on these instead of introducing inline colors.

export type MobileColorScheme = 'light' | 'dark'

const darkColors = {
  // --background, --sidebar, --secondary, --border
  bgBase: '#0a0a0a',
  bgPanel: '#171717',
  bgRaised: '#262626',
  borderSubtle: 'rgba(255, 255, 255, 0.07)',
  editorSurface: '#1e1e1e',
  // Sheets sit a step above the screen, their groups a step above the sheet (the desktop's sidebar and secondary).
  sheetSurface: '#171717',
  sheetGroup: '#262626',
  // A translucent grey that reads on any surface: off switches, and chips or picked segments on a sheet group.
  translucentFill: 'rgba(120, 120, 128, 0.36)',
  // --chat-composer-surface painted over --chat-canvas, and --chat-composer-border.
  composerSurface: '#1f1f1f',
  composerBorder: 'rgba(250, 250, 250, 0.09)',
  composerControl: '#262626',
  // A floating card's hairline edge (the answer card), a step stronger than the composer's.
  floatingCardBorder: 'rgba(250, 250, 250, 0.16)',
  // An unfilled choice's edge on a card, 3:1 against it (WCAG 1.4.11), and the faint fill of the picked one.
  choiceBorder: 'rgba(255, 255, 255, 0.34)',
  choiceSelectedFill: 'rgba(134, 239, 172, 0.08)',
  // A small filled pill on a card (a queued row's Steer): light needs more than bgRaised to read on white.
  cardPillFill: '#262626',
  // A text field's edge, 3:1 on the screen, a sheet and a sheet group (WCAG 1.4.11): desktop's dark --ring.
  inputBorder: '#737373',
  skillToken: '#8ab4f8',
  skillTokenSurface: 'rgba(59, 130, 246, 0.2)',
  // Your own message: --chat-user-surface and --chat-user-border over --chat-canvas, text in --chat-foreground-strong.
  chatUserSurface: '#262626',
  chatUserBorder: 'rgba(250, 250, 250, 0.06)',
  chatForegroundStrong: '#e3e3e3',

  // --foreground, --muted-foreground, --chat-foreground-faint
  textPrimary: '#fafafa',
  textSecondary: '#acacac',
  textMuted: '#898989',

  // --primary: the filled primary-action surface.
  surfaceBright: '#e5e5e5',
  // A list screen's floating create (+) button: the accent, as on Home, since a pale disc glares on the dark page.
  createActionFill: '#3276f2',
  onCreateActionFill: '#ffffff',

  accentBlue: '#3276f2',
  // White text preserves contrast on saturated accent fills.
  onAccent: '#ffffff',

  // --status-success, --status-warning, --destructive
  statusGreen: '#86efac',
  statusAmber: '#eab308',
  statusRed: '#ff6568',
  // Desktop's --destructive-foreground: dark ink on the light-red dark fill.
  onStatusRed: '#450a0a',
  // Match desktop’s merge CTA fill and text.
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  // Desktop's merged-PR purple (`dark:text-purple-300`).
  statusPurple: '#d8b4fe',
  gitDecorationAdded: '#81b88b',
  gitDecorationDeleted: '#c74e39',
  // GitHub's (Primer) diff colours, Kelvin's choice for every phone diff: row ground, line-number cell over it,
  // the +/− sign, unchanged line numbers, and the blue "unchanged lines" fold band.
  diffAddedBg: 'rgba(46, 160, 67, 0.15)',
  diffDeletedBg: 'rgba(248, 81, 73, 0.13)',
  diffAddedGutter: 'rgba(63, 185, 80, 0.3)',
  diffDeletedGutter: 'rgba(248, 81, 73, 0.3)',
  diffAddedSign: '#3fb950',
  diffDeletedSign: '#f85149',
  diffLineNumber: '#6e7681',
  diffFoldBg: 'rgba(56, 139, 253, 0.1)',
  diffFoldGutter: 'rgba(56, 139, 253, 0.22)',
  diffFoldText: '#4493f8',
  // Desktop's `--chat-diff-*`: decoration mixed toward foreground for tinted rows.
  chatDiffAdded: '#a5ccac',
  chatDiffRemoved: '#d68273',

  // GitHub's Primer dark syntax palette (prettylights); type is its built-in orange, tag covers keys and tag names.
  syntaxComment: '#8b949e',
  syntaxKeyword: '#ff7b72',
  syntaxString: '#a5d6ff',
  syntaxNumber: '#79c0ff',
  syntaxType: '#ffa657',
  syntaxFunction: '#d2a8ff',
  syntaxVariable: '#ffa657',
  syntaxMeta: '#79c0ff',
  syntaxTag: '#7ee787',

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
  // Light inverts it: a grey sheet under white groups, as iOS does.
  sheetSurface: '#f5f5f5',
  sheetGroup: '#ffffff',
  translucentFill: 'rgba(120, 120, 128, 0.16)',
  composerSurface: '#ffffff',
  composerBorder: 'rgba(10, 10, 10, 0.11)',
  composerControl: '#f5f5f5',
  floatingCardBorder: 'rgba(10, 10, 10, 0.14)',
  choiceBorder: 'rgba(0, 0, 0, 0.44)',
  choiceSelectedFill: 'rgba(20, 118, 56, 0.06)',
  cardPillFill: 'rgba(120, 120, 128, 0.16)',
  // Desktop's light --ring (#a1a1a1) is under 3:1 on white, so both schemes share the dark one.
  inputBorder: '#737373',
  skillToken: '#1d4ed8',
  skillTokenSurface: 'rgba(59, 130, 246, 0.12)',
  chatUserSurface: '#f5f5f5',
  chatUserBorder: 'rgba(10, 10, 10, 0.07)',
  chatForegroundStrong: '#1e1e1e',

  textPrimary: '#0a0a0a',
  textSecondary: '#696969',
  textMuted: '#696969',

  surfaceBright: '#171717',
  createActionFill: '#171717',
  onCreateActionFill: '#ffffff',

  accentBlue: '#225be3',
  onAccent: '#ffffff',

  statusGreen: '#147638',
  statusAmber: '#ca8a04',
  statusRed: '#e40014',
  onStatusRed: '#ffffff',
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  statusPurple: '#9333ea',
  gitDecorationAdded: '#587c0c',
  gitDecorationDeleted: '#ad0707',
  diffAddedBg: '#dafbe1',
  diffDeletedBg: '#ffebe9',
  diffAddedGutter: '#aceebb',
  diffDeletedGutter: '#ffcecb',
  diffAddedSign: '#1a7f37',
  diffDeletedSign: '#cf222e',
  diffLineNumber: '#6e7781',
  diffFoldBg: '#ddf4ff',
  diffFoldGutter: 'rgba(84, 174, 255, 0.4)',
  diffFoldText: '#0969da',
  chatDiffAdded: '#415a0b',
  chatDiffRemoved: '#7c0808',

  // GitHub's Primer light syntax palette (prettylights).
  syntaxComment: '#59636e',
  syntaxKeyword: '#cf222e',
  syntaxString: '#0a3069',
  syntaxNumber: '#0550ae',
  syntaxType: '#953800',
  syntaxFunction: '#8250df',
  syntaxVariable: '#953800',
  syntaxMeta: '#0550ae',
  syntaxTag: '#116329',

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

// Three shape types: one radius for what you tap, one for what holds content, and concentric nesting.
export const radii = {
  /** Everything you tap: buttons, icon buttons, text fields, pickers, segmented controls, key caps. */
  control: 12,
  /** Labels and round buttons: badges, chips, status pills, dots, avatars, and the composer's own buttons. */
  pill: 999,
  /** Everything that holds content: cards, groups, sheets, banners, code boxes, multi-line boxes, menus. */
  surface: 16,
  /** Layers floating over content: the composer box and dialogs. */
  floating: 24,
  /** Square icon tiles. */
  tile: 10,
  /** Inline code, check squares and tiny icons. */
  mark: 4
} as const

/** A shape inside another keeps its curve parallel to the parent's: the parent radius minus the gap between them. */
export function concentricRadius(parentRadius: number, inset: number): number {
  return Math.max(radii.mark, parentRadius - inset)
}

export const typography = {
  titleSize: 18,
  bodySize: 14,
  metaSize: 12,
  monoFamily: codeFontFamily
} as const

// One press and one disabled look for every control; fills on press use colors.translucentFill.
export const feedback = {
  pressedOpacity: 0.7,
  disabledOpacity: 0.4
} as const

/** The pressed look for a button: `style={({ pressed }) => [styles.button, pressed && pressedStyle]}`. */
export const pressedStyle = { opacity: feedback.pressedOpacity } as const
