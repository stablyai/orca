import { createPromptDismissalStore } from '../../../../../src/shared/prompt-dismissal-store'

export type MobileNativeChatPromptDismissal = {
  sessionKey: string | null
  content: string
  /** The host wait's start for a status-backed prompt; null for a transcript-only one. */
  startedAt: number | null
  state: 'answered' | 'collapsed'
}

export const mobileNativeChatPromptDismissals =
  createPromptDismissalStore<MobileNativeChatPromptDismissal>()
