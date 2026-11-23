import { darkContentColors, lightContentColors } from './mobile-content-colors'
import type { MobilePalette } from './mobile-palette-roles'

// Material 3 roles from SchemeTonalSpot seeded with Orca's accent (materialSeedColor), the scheme Compose hosts
// regenerate from the same seed. Material has no success, warning or purple roles, so those keep desktop's tokens.

export const darkPalette: MobilePalette = {
  ...darkContentColors,
  // surface, surfaceContainer, surfaceContainerHighest, outlineVariant
  bgBase: '#121318',
  bgPanel: '#1e1f25',
  bgRaised: '#33343a',
  borderSubtle: '#44464f',
  // surfaceContainerLow (the bottom sheet) and surfaceContainerHigh.
  sheetSurface: '#1a1b20',
  sheetGroup: '#282a2f',
  // surface under surfaceContainerHigh cards; onSurfaceVariant for trailing icons.
  groupedBackground: '#121318',
  groupedSurface: '#282a2f',
  disclosureTint: '#c5c6d0',
  // onSurface at the 12% state-layer opacity.
  translucentFill: 'rgba(226, 226, 233, 0.12)',
  // surfaceContainerHigh, outlineVariant, surfaceContainerHighest
  composerSurface: '#282a2f',
  composerBorder: '#44464f',
  composerControl: '#33343a',
  // outline, 4.5:1 or more on every container.
  floatingCardBorder: '#8f9099',
  choiceBorder: '#8f9099',
  choiceSelectedFill: 'rgba(134, 239, 172, 0.08)',
  // surfaceContainerHighest
  cardPillFill: '#33343a',
  inputBorder: '#8f9099',
  // surfaceContainerHigh
  chatUserSurface: '#282a2f',
  chatUserBorder: 'rgba(250, 250, 250, 0.06)',
  chatForegroundStrong: '#e3e3e3',

  // onSurface, onSurfaceVariant, outline
  textPrimary: '#e2e2e9',
  textSecondary: '#c5c6d0',
  textMuted: '#8f9099',

  // inverseSurface
  surfaceBright: '#e2e2e9',
  // primaryContainer and onPrimaryContainer, Material's FAB.
  createActionFill: '#2e4578',
  onCreateActionFill: '#d9e2ff',

  // primary, onPrimary
  accentBlue: '#b0c6ff',
  onAccent: '#152e60',

  statusGreen: '#86efac',
  statusAmber: '#eab308',
  agentQuestion: '#f97316',
  agentQuestionText: '#fdba74',
  agentQuestionTint: 'rgba(249, 115, 22, 0.12)',
  // error, onError
  statusRed: '#ffb4ab',
  onStatusRed: '#690004',
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  statusPurple: '#d8b4fe'
}

export const lightPalette: MobilePalette = {
  ...lightContentColors,
  bgBase: '#faf8ff',
  bgPanel: '#eeedf4',
  bgRaised: '#e2e2e9',
  borderSubtle: '#c5c6d0',
  sheetSurface: '#f4f3fa',
  sheetGroup: '#e8e7ef',
  groupedBackground: '#faf8ff',
  groupedSurface: '#e8e7ef',
  disclosureTint: '#44464f',
  translucentFill: 'rgba(26, 27, 32, 0.12)',
  composerSurface: '#e8e7ef',
  composerBorder: '#c5c6d0',
  composerControl: '#e2e2e9',
  // outline, 3.5:1 or more on every container.
  floatingCardBorder: '#757780',
  choiceBorder: '#757780',
  choiceSelectedFill: 'rgba(20, 118, 56, 0.06)',
  cardPillFill: '#e2e2e9',
  inputBorder: '#757780',
  chatUserSurface: '#e8e7ef',
  chatUserBorder: 'rgba(10, 10, 10, 0.07)',
  chatForegroundStrong: '#1e1e1e',

  // onSurfaceVariant for both lower tiers: light outline is 4.2:1 on surface.
  textPrimary: '#1a1b20',
  textSecondary: '#44464f',
  textMuted: '#44464f',

  surfaceBright: '#2f3036',
  createActionFill: '#d9e2ff',
  onCreateActionFill: '#001945',

  accentBlue: '#475d92',
  onAccent: '#ffffff',

  statusGreen: '#147638',
  statusAmber: '#ca8a04',
  agentQuestion: '#ea580c',
  agentQuestionText: '#c2410c',
  agentQuestionTint: 'rgba(234, 88, 12, 0.12)',
  statusRed: '#ba1a1a',
  onStatusRed: '#ffffff',
  mergeGreen: '#16a34a',
  onMergeGreen: '#ffffff',
  statusPurple: '#9333ea'
}
