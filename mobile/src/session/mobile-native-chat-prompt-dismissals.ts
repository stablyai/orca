import { createPromptDismissalStore } from '../../../src/shared/prompt-dismissal-store'

export type MobileNativeChatPromptDismissal = {
  sessionKey: string | null
  promptKey: string
  state: 'answered' | 'collapsed'
}

export const mobileNativeChatPromptDismissals =
  createPromptDismissalStore<MobileNativeChatPromptDismissal>()
