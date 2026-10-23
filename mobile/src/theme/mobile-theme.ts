// Orca mobile design tokens — matches desktop graphite/dark palette.
// All screen files should import from here instead of using inline hex values.
import { fontFamilies } from './font-families'

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
  terminalBg: '#1a1b26',

  // The shared components' palette. Translucent white rather than solid greys, so a fill, a press
  // or a hairline reads the same on the canvas, a group and a sheet.
  fill: 'rgba(255, 255, 255, 0.075)',
  fillPressed: 'rgba(255, 255, 255, 0.14)',
  fieldFill: 'rgba(255, 255, 255, 0.05)',
  // A sheet sits one step above the page so it reads as a layer, not a recolour of the page.
  sheet: '#1c1c1c',
  // Grouped rows are translucent so they lift the same step on the page and inside a sheet.
  groupFill: 'rgba(255, 255, 255, 0.06)',
  fieldBorder: 'rgba(255, 255, 255, 0.1)',
  fieldBorderFocused: 'rgba(255, 255, 255, 0.3)',
  separator: 'rgba(255, 255, 255, 0.08)',
  switchTrackOff: 'rgba(255, 255, 255, 0.16)',
  // The one filled action on a screen or sheet.
  primary: '#f4f4f4',
  primaryPressed: '#d6d6d6',
  onPrimary: '#101010',
  // Destructive actions are red text on a secondary fill, never a red fill outside a confirm.
  danger: '#ff6b6b',
  // Tinted notice surfaces for warning and error banners.
  warningFill: 'rgba(245, 158, 11, 0.1)',
  errorFill: 'rgba(255, 107, 107, 0.1)',
  onDanger: '#ffffff',
  // A floating control pressed: one step above `bgRaised`.
  raisedPressed: '#303030'
} as const

/** An opaque control floating over scrolling content, such as a bottom toolbar's capsules. */
export const floatingSurface = {
  backgroundColor: colors.bgRaised,
  borderWidth: 1,
  borderColor: colors.separator,
  shadowColor: '#000',
  shadowOpacity: 0.5,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 6 },
  elevation: 6
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
  composerItem: 12,
  field: 14,
  group: 16,
  replyBox: 22,
  sheet: 30,
  pill: 999
} as const

export const typography = {
  titleSize: 18,
  bodySize: 14,
  metaSize: 12,
  monoFamily: 'monospace' as const
} as const

type TextStep = {
  fontSize: number
  lineHeight: number
  fontWeight: '400' | '500' | '600'
  letterSpacing?: number
  fontFamily?: string
}

function step(fontSize: number, lineHeight: number, fontWeight: TextStep['fontWeight'] = '400') {
  const tracked = fontSize >= 20 ? { letterSpacing: -fontSize * 0.018 } : {}
  return { fontSize, lineHeight, fontWeight, ...tracked, ...fontFamilies.sans } satisfies TextStep
}

/**
 * The type ramp. Every new or redesigned text uses one of these steps; nothing goes below caption.
 * Geist runs wider than SF, so body is 16 and reads like iOS's 17.
 */
export const textStyles = {
  largeTitle: step(30, 36, '600'),
  title: step(22, 28, '600'),
  headline: step(17, 22, '600'),
  body: step(16, 23),
  callout: step(15, 21),
  subhead: step(14, 20),
  footnote: step(13, 18),
  caption: step(12, 16)
} as const

/** Press feedback and sheet motion, shared so every control moves the same way. */
export const motion = {
  pressedScale: 0.97,
  pressedIconScale: 0.92,
  pressInMs: 80,
  pressOutMs: 240,
  // iOS's sheet curve: fast out, long settle, no overshoot.
  sheetEasing: 'cubic-bezier(0.32, 0.72, 0, 1)',
  sheetMs: 500,
  disabledOpacity: 0.4
} as const

/** Smallest box a tap target lays out to. Touch size comes from layout: the page ignores hitSlop. */
export const MIN_TOUCH_TARGET = 44
