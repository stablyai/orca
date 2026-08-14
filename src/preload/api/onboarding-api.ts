import type { OnboardingState } from '../../shared/onboarding-state-types'

export type OnboardingApi = {
  get: () => Promise<OnboardingState>
  // Why: main merges the checklist field-by-field, so a partial checklist is fine.
  update: (
    updates: Partial<Omit<OnboardingState, 'checklist'>> & {
      checklist?: Partial<OnboardingState['checklist']>
    }
  ) => Promise<OnboardingState>
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
