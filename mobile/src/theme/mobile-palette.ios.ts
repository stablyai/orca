import { darkContentColors, lightContentColors } from './mobile-content-colors'
import type { MobilePalette } from './mobile-palette-roles'

// Apple's UIKit system colours, resolved to hex per scheme because callers interpolate and compose them.
// Dark uses the elevated variants (secondary/tertiary system backgrounds) for sheets, as UIKit does in a sheet.

export const darkPalette: MobilePalette = {
  ...darkContentColors,
  // systemBackground, secondarySystemBackground, systemGray5, separator
  bgBase: '#000000',
  bgPanel: '#1c1c1e',
  bgRaised: '#2c2c2e',
  borderSubtle: 'rgba(84, 84, 88, 0.6)',
  // Elevated systemGroupedBackground and secondarySystemGroupedBackground.
  sheetSurface: '#1c1c1e',
  sheetGroup: '#2c2c2e',
  // systemGroupedBackground, secondarySystemGroupedBackground, tertiaryLabel
  groupedBackground: '#000000',
  groupedSurface: '#1c1c1e',
  disclosureTint: 'rgba(235, 235, 245, 0.3)',
  // systemFill
  translucentFill: 'rgba(120, 120, 128, 0.36)',
  // secondarySystemBackground, separator, systemGray5
  composerSurface: '#1c1c1e',
  composerBorder: 'rgba(84, 84, 88, 0.6)',
  composerControl: '#2c2c2e',
  // systemGray3
  floatingCardBorder: '#48484a',
  // systemGray, 5:1 on the card.
  choiceBorder: '#8e8e93',
  choiceSelectedFill: 'rgba(134, 239, 172, 0.08)',
  // secondarySystemFill
  cardPillFill: 'rgba(120, 120, 128, 0.32)',
  // systemGray, 4.2:1 on the lightest sheet group.
  inputBorder: '#8e8e93',
  // systemGray5, as Messages' received bubble.
  chatUserSurface: '#2c2c2e',
  chatUserBorder: 'rgba(250, 250, 250, 0.06)',
  chatForegroundStrong: '#e3e3e3',

  // label, secondaryLabel, systemGray
  textPrimary: '#ffffff',
  textSecondary: 'rgba(235, 235, 245, 0.6)',
  textMuted: '#8e8e93',

  // systemGray5 in light: the inverse fill under bgBase text.
  surfaceBright: '#e5e5ea',
  // systemBlue
  createActionFill: '#0a84ff',
  onCreateActionFill: '#ffffff',

  // systemBlue under white labels, as UIKit's filled buttons.
  accentBlue: '#0a84ff',
  onAccent: '#ffffff',

  // systemGreen, systemYellow, systemOrange, systemRed
  statusGreen: '#30d158',
  statusAmber: '#ffd60a',
  agentQuestion: '#ff9f0a',
  statusRed: '#ff453a',
  // Dark ink holds 4.7:1 on systemRed, where white falls to 3.4:1.
  onStatusRed: '#450a0a',
  // Desktop's merge CTA fill and text.
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  // systemPurple
  statusPurple: '#bf5af2'
}

// Light status colours are the Increase Contrast variants, as the standard ones fall under 3:1 on white.
export const lightPalette: MobilePalette = {
  ...lightContentColors,
  // systemBackground, secondarySystemBackground, systemGray5, separator
  bgBase: '#ffffff',
  bgPanel: '#f2f2f7',
  bgRaised: '#e5e5ea',
  borderSubtle: 'rgba(60, 60, 67, 0.29)',
  // systemGroupedBackground and secondarySystemGroupedBackground.
  sheetSurface: '#f2f2f7',
  sheetGroup: '#ffffff',
  groupedBackground: '#f2f2f7',
  groupedSurface: '#ffffff',
  disclosureTint: 'rgba(60, 60, 67, 0.3)',
  // systemFill
  translucentFill: 'rgba(120, 120, 128, 0.2)',
  // systemBackground, separator, systemGray6
  composerSurface: '#ffffff',
  composerBorder: 'rgba(60, 60, 67, 0.29)',
  composerControl: '#f2f2f7',
  // systemGray3
  floatingCardBorder: '#c7c7cc',
  // systemGray, 3.3:1 on the white card.
  choiceBorder: '#8e8e93',
  choiceSelectedFill: 'rgba(20, 118, 56, 0.06)',
  // secondarySystemFill
  cardPillFill: 'rgba(120, 120, 128, 0.16)',
  // Increase Contrast systemGray: plain systemGray is 2.9:1 on systemGroupedBackground.
  inputBorder: '#6c6c70',
  // systemGray6
  chatUserSurface: '#f2f2f7',
  chatUserBorder: 'rgba(10, 10, 10, 0.07)',
  chatForegroundStrong: '#1e1e1e',

  // label; secondaryLabel at the Increase Contrast opacity (0.6 is 3.3:1); Increase Contrast systemGray.
  textPrimary: '#000000',
  textSecondary: 'rgba(60, 60, 67, 0.76)',
  textMuted: '#6c6c70',

  // secondarySystemBackground in dark: the inverse fill under bgBase text.
  surfaceBright: '#1c1c1e',
  createActionFill: '#007aff',
  onCreateActionFill: '#ffffff',

  accentBlue: '#007aff',
  onAccent: '#ffffff',

  statusGreen: '#248a3d',
  statusAmber: '#b25000',
  agentQuestion: '#c93400',
  statusRed: '#d70015',
  onStatusRed: '#ffffff',
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  statusPurple: '#8944ab'
}
