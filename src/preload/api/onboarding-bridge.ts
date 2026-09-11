import { ipcRenderer } from 'electron'
import type { OnboardingConsent, OnboardingState } from '../../shared/onboarding-state-types'
import type { PreloadApi } from '../api-types'

export const onboardingApi = {
  get: (): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:get'),
  update: (
    updates: Partial<Omit<OnboardingState, 'checklist'>> & {
      checklist?: Partial<OnboardingState['checklist']>
    },
    consent?: OnboardingConsent
  ): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:update', updates, consent)
} satisfies PreloadApi['onboarding']
