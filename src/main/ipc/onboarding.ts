import { ipcMain } from 'electron'
import { sanitizeOnboardingUpdate } from '../persistence/applying-settings/onboarding-normalization'
import type { Store } from '../persistence/loading-store/store'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { ChatUiLaunchTipVariant } from '../../shared/native-chat/chat-ui-launch-tip-audience'
import { isChatUiLaunchTipDeferredForConsent } from '../telemetry/chat-ui-launch-tip-cohort'

export function registerOnboardingHandlers(store: Store): void {
  ipcMain.removeHandler('onboarding:get')
  ipcMain.removeHandler('onboarding:update')
  ipcMain.removeHandler('onboarding:getChatUiLaunchTipVariant')

  ipcMain.handle('onboarding:get', (): OnboardingState => store.getOnboarding())
  // Sanitize untyped IPC keys and values before persisting onboarding state.
  ipcMain.handle('onboarding:update', (_event, updates: unknown): OnboardingState => {
    return store.updateOnboarding(sanitizeOnboardingUpdate(updates))
  })
  // 'none' skips the tip this launch without marking it seen, so it returns once consent resolves.
  ipcMain.handle('onboarding:getChatUiLaunchTipVariant', (): ChatUiLaunchTipVariant =>
    isChatUiLaunchTipDeferredForConsent() ? 'none' : store.getChatUiLaunchTipVariant()
  )
}
