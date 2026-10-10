import { ipcRenderer } from 'electron'
import type { NativeChatUpgradeTipVariant } from '../../shared/native-chat-upgrade-tip-audience'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { PreloadApi } from '../api-types'

export const onboardingApi = {
  get: (): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:get'),
  update: (
    updates: Partial<Omit<OnboardingState, 'checklist'>> & {
      checklist?: Partial<OnboardingState['checklist']>
    }
  ): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:update', updates),
  getNativeChatUpgradeTipVariant: (): Promise<NativeChatUpgradeTipVariant> =>
    ipcRenderer.invoke('onboarding:getNativeChatUpgradeTipVariant')
} satisfies PreloadApi['onboarding']
