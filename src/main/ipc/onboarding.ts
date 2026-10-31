import { ipcMain } from 'electron'
import { sanitizeOnboardingUpdate, type Store } from '../persistence'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { ChatUiLaunchTipVariant } from '../../shared/native-chat/chat-ui-launch-tip-audience'

export function registerOnboardingHandlers(store: Store): void {
  ipcMain.removeHandler('onboarding:get')
  ipcMain.removeHandler('onboarding:update')
  ipcMain.removeHandler('onboarding:getChatUiLaunchTipVariant')

  ipcMain.handle('onboarding:get', (): OnboardingState => store.getOnboarding())
  // Sanitize untyped IPC keys and values before persisting onboarding state.
  ipcMain.handle('onboarding:update', (_event, updates: unknown): OnboardingState => {
    return store.updateOnboarding(sanitizeOnboardingUpdate(updates))
  })
  ipcMain.handle('onboarding:getChatUiLaunchTipVariant', (): ChatUiLaunchTipVariant =>
    store.getChatUiLaunchTipVariant()
  )
}
