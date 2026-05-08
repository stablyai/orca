import { ipcMain } from 'electron'
import { sanitizeOnboardingUpdate, type Store } from '../persistence'
import type { OnboardingState } from '../../shared/types'

export function registerOnboardingHandlers(store: Store): void {
  ipcMain.removeHandler('onboarding:get')
  ipcMain.removeHandler('onboarding:update')

  ipcMain.handle('onboarding:get', (): OnboardingState => store.getOnboarding())
  // Why: never trust renderer input — a compromised/buggy caller could send
  // unknown keys or wrong-typed values that would poison persisted state.
  // Run every update through the shared whitelist sanitizer.
  ipcMain.handle('onboarding:update', (_event, updates: unknown): OnboardingState => {
    return store.updateOnboarding(sanitizeOnboardingUpdate(updates))
  })
}
