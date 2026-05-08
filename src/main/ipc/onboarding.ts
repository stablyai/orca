import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { OnboardingState } from '../../shared/types'

export function registerOnboardingHandlers(store: Store): void {
  ipcMain.removeHandler('onboarding:get')
  ipcMain.removeHandler('onboarding:update')

  ipcMain.handle('onboarding:get', (): OnboardingState => store.getOnboarding())
  ipcMain.handle(
    'onboarding:update',
    (_event, updates: Partial<OnboardingState>): OnboardingState => {
      return store.updateOnboarding(updates)
    }
  )
}
