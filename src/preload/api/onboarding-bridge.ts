import { ipcRenderer } from 'electron'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { PreloadApi } from '../api-types'

export const onboardingApi = {
  get: (): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:get'),
  update: (
    updates: Partial<Omit<OnboardingState, 'checklist'>> & {
      checklist?: Partial<OnboardingState['checklist']>
    }
  ): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:update', updates)
} satisfies PreloadApi['onboarding']
