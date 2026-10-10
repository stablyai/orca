import { createPromptDismissalStore } from '../../../src/shared/prompt-dismissal-store'

export type MobileNativeChatPromptDismissal = {
  sessionKey: string | null
  promptKey: string
  /** Answered: the card is gone. Collapsed: the user folded it to a strip above the composer. */
  state: 'answered' | 'collapsed'
}

/** Each chat tab's dismissed prompt occurrence, keyed by card kind and tab scope. */
export const mobileNativeChatPromptDismissals =
  createPromptDismissalStore<MobileNativeChatPromptDismissal>()
