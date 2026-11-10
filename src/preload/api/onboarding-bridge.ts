import { ipcRenderer } from 'electron'
import type { ChatUiLaunchTipVariant } from '../../shared/native-chat/chat-ui-launch-tip-audience'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { PreloadApi } from '../api-types'

export const onboardingApi = {
  get: (): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:get'),
  update: (
    updates: Partial<Omit<OnboardingState, 'checklist'>> & {
      checklist?: Partial<OnboardingState['checklist']>
    }
  ): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:update', updates),
  getChatUiLaunchTipVariant: (): Promise<ChatUiLaunchTipVariant> =>
    ipcRenderer.invoke('onboarding:getChatUiLaunchTipVariant')
} satisfies PreloadApi['onboarding']
