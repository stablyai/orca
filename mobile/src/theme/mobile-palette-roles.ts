import type { MobileContentColors } from './mobile-content-colors'

// The chrome roles each platform's palette fills: iOS system colours, Material 3 roles, or desktop tokens on the web.
export type MobileChromeColors = {
  /** The screen. */
  readonly bgBase: string
  /** A panel or active row a step above the screen. */
  readonly bgPanel: string
  /** Chips, pressed rows and other fills a step above a panel. */
  readonly bgRaised: string
  /** Hairlines between rows and around cards. */
  readonly borderSubtle: string
  /** Sheets sit a step above the screen, their groups a step above the sheet. */
  readonly sheetSurface: string
  readonly sheetGroup: string
  /** A screen of grouped lists (settings), and its groups. */
  readonly groupedBackground: string
  readonly groupedSurface: string
  /** A row's trailing chevron. */
  readonly disclosureTint: string
  /** A translucent grey that reads on any surface: off switches, and chips or picked segments on a sheet group. */
  readonly translucentFill: string
  /** The composer box over the chat, its hairline, and its buttons. */
  readonly composerSurface: string
  readonly composerBorder: string
  readonly composerControl: string
  /** A floating card's hairline edge (the answer card), a step stronger than the composer's. */
  readonly floatingCardBorder: string
  /** An unfilled choice's edge on a card, 3:1 against it (WCAG 1.4.11), and the faint fill of the picked one. */
  readonly choiceBorder: string
  readonly choiceSelectedFill: string
  /** A small filled pill on a card (a queued row's Steer). */
  readonly cardPillFill: string
  /** A text field's edge, 3:1 on the screen, a sheet and a sheet group (WCAG 1.4.11). */
  readonly inputBorder: string
  /** Your own message: its bubble, edge and text. */
  readonly chatUserSurface: string
  readonly chatUserBorder: string
  readonly chatForegroundStrong: string
  /** Text tiers, each 4.5:1 on the screen and its panels; textMuted stays opaque hex as callers append alpha. */
  readonly textPrimary: string
  readonly textSecondary: string
  readonly textMuted: string
  /** The inverse filled action surface; its text uses bgBase. */
  readonly surfaceBright: string
  /** A list screen's floating create (+) button and its glyph. */
  readonly createActionFill: string
  readonly onCreateActionFill: string
  /** The app tint, and text or glyphs on its fills. */
  readonly accentBlue: string
  readonly onAccent: string
  readonly statusGreen: string
  readonly statusAmber: string
  /** Something waits on the owner (an item that needs you). */
  readonly agentQuestion: string
  /** The Needs you tag's words and fill. */
  readonly agentQuestionText: string
  readonly agentQuestionTint: string
  /** Destructive and error, and text on its fills. */
  readonly statusRed: string
  readonly onStatusRed: string
  /** The merge CTA fill and its text. */
  readonly mergeGreen: string
  readonly onMergeGreen: string
  /** A merged pull request. */
  readonly statusPurple: string
}

export type MobilePalette = MobileChromeColors & MobileContentColors
