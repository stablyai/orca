import type { NativeChatUpgradeTipVariant } from '../../shared/native-chat-upgrade-tip-audience'
import type { OnboardingState } from '../../shared/onboarding-state-types'

export type OnboardingApi = {
  get: () => Promise<OnboardingState>
  // Main merges checklist fields individually.
  update: (
    updates: Partial<Omit<OnboardingState, 'checklist'>> & {
      checklist?: Partial<OnboardingState['checklist']>
    }
  ) => Promise<OnboardingState>
  /** Audience is fixed from the profile saved before the chat upgrade. */
  getNativeChatUpgradeTipVariant: () => Promise<NativeChatUpgradeTipVariant>
}

export type StarNagApi = {
  onShow: (
    callback: (payload?: { mode?: 'gh' | 'web'; surface?: 'card' | 'toast' }) => void
  ) => () => void
  onHide: (callback: () => void) => () => void
  dismiss: () => Promise<void>
  later: () => Promise<void>
  complete: () => Promise<void>
  disable: () => Promise<void>
  openWeb: () => Promise<void>
  starOrca: () => Promise<boolean>
  forceShow: () => Promise<void>
  agentValueMoment: () => Promise<{ status: 'ready'; mode: 'gh' | 'web' } | { status: 'skipped' }>
  showAgentValueMoment: () => Promise<void>
  onboardingCompleted: () => Promise<void>
}
