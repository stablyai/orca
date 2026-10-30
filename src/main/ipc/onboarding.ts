import { ipcMain } from 'electron'
import { sanitizeOnboardingUpdate, type Store } from '../persistence'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { NativeChatUpgradeTipVariant } from '../../shared/native-chat/native-chat-upgrade-tip-audience'

export function registerOnboardingHandlers(store: Store): void {
  ipcMain.removeHandler('onboarding:get')
  ipcMain.removeHandler('onboarding:update')
  ipcMain.removeHandler('onboarding:getNativeChatUpgradeTipVariant')

  ipcMain.handle('onboarding:get', (): OnboardingState => store.getOnboarding())
  // Sanitize untyped IPC keys and values before persisting onboarding state.
  ipcMain.handle('onboarding:update', (_event, updates: unknown): OnboardingState => {
    return store.updateOnboarding(sanitizeOnboardingUpdate(updates))
  })
  ipcMain.handle('onboarding:getNativeChatUpgradeTipVariant', (): NativeChatUpgradeTipVariant =>
    store.getNativeChatUpgradeTipVariant()
  )
}
