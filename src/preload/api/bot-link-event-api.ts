import type { BotDeepLinkOutcome } from '../../shared/bot-deep-link'

/** A bot link main holds for the window until it asks; the outcome says where it led. */
export type BotLinkEventApi = {
  onBotLinkPending: (callback: () => void) => () => void
  consumePendingBotLink: () => Promise<BotDeepLinkOutcome | null>
}
