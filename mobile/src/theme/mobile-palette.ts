import { darkContentColors, lightContentColors } from './mobile-content-colors'
import type { MobilePalette } from './mobile-palette-roles'

// The web (and tests) keep desktop's main.css tokens; iOS and Android use their own design languages.

export const darkPalette: MobilePalette = {
  ...darkContentColors,
  // --background, --sidebar, --secondary, --border
  bgBase: '#0a0a0a',
  bgPanel: '#171717',
  bgRaised: '#262626',
  borderSubtle: 'rgba(255, 255, 255, 0.07)',
  // The desktop's sidebar and secondary.
  sheetSurface: '#171717',
  sheetGroup: '#262626',
  // The screen and sheet groups' tokens, as before grouped screens had their own.
  groupedBackground: '#0a0a0a',
  groupedSurface: '#262626',
  disclosureTint: '#898989',
  translucentFill: 'rgba(120, 120, 128, 0.36)',
  // --chat-composer-surface painted over --chat-canvas, and --chat-composer-border.
  composerSurface: '#1f1f1f',
  composerBorder: 'rgba(250, 250, 250, 0.09)',
  composerControl: '#262626',
  floatingCardBorder: 'rgba(250, 250, 250, 0.16)',
  choiceBorder: 'rgba(255, 255, 255, 0.34)',
  choiceSelectedFill: 'rgba(134, 239, 172, 0.08)',
  cardPillFill: '#262626',
  // Desktop's dark --ring.
  inputBorder: '#737373',
  // --chat-user-surface and --chat-user-border over --chat-canvas, text in --chat-foreground-strong.
  chatUserSurface: '#262626',
  chatUserBorder: 'rgba(250, 250, 250, 0.06)',
  chatForegroundStrong: '#e3e3e3',

  // --foreground, --muted-foreground, --chat-foreground-faint
  textPrimary: '#fafafa',
  textSecondary: '#acacac',
  textMuted: '#898989',

  // --primary
  surfaceBright: '#e5e5e5',
  // The accent, as on Home, since a pale disc glares on the dark page.
  createActionFill: '#3276f2',
  onCreateActionFill: '#ffffff',

  accentBlue: '#3276f2',
  onAccent: '#ffffff',

  // --status-success, --status-warning, --agent-question, --destructive
  statusGreen: '#86efac',
  statusAmber: '#eab308',
  agentQuestion: '#f97316',
  statusRed: '#ff6568',
  // Desktop's --destructive-foreground: dark ink on the light-red dark fill.
  onStatusRed: '#450a0a',
  // Desktop's merge CTA fill and text.
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  // Desktop's merged-PR purple (`dark:text-purple-300`).
  statusPurple: '#d8b4fe'
}

export const lightPalette: MobilePalette = {
  ...lightContentColors,
  bgBase: '#ffffff',
  bgPanel: '#fafafa',
  bgRaised: '#f5f5f5',
  borderSubtle: '#e5e5e5',
  // Light inverts it: a grey sheet under white groups, as iOS does.
  sheetSurface: '#f5f5f5',
  sheetGroup: '#ffffff',
  groupedBackground: '#ffffff',
  groupedSurface: '#ffffff',
  disclosureTint: '#696969',
  translucentFill: 'rgba(120, 120, 128, 0.16)',
  composerSurface: '#ffffff',
  composerBorder: 'rgba(10, 10, 10, 0.11)',
  composerControl: '#f5f5f5',
  floatingCardBorder: 'rgba(10, 10, 10, 0.14)',
  choiceBorder: 'rgba(0, 0, 0, 0.44)',
  choiceSelectedFill: 'rgba(20, 118, 56, 0.06)',
  // bgRaised is too faint to read on white.
  cardPillFill: 'rgba(120, 120, 128, 0.16)',
  // Desktop's light --ring (#a1a1a1) is under 3:1 on white, so both schemes share the dark one.
  inputBorder: '#737373',
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
  agentQuestion: '#ea580c',
  statusRed: '#e40014',
  onStatusRed: '#ffffff',
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  statusPurple: '#9333ea'
}
