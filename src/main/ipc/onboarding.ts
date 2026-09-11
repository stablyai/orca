import { app, ipcMain } from 'electron'
import { sanitizeOnboardingUpdate, type Store } from '../persistence'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import {
  installManagedAgentHooks,
  isAgentStatusHooksEnabled
} from '../agent-hooks/managed-agent-hook-controls'
import { recordManagedHookInstallFailure } from '../agent-hooks/install-telemetry'
import { isManagedHookInstallDeferredForFirstRun } from '../agent-hooks/managed-hook-first-run-gate'

export function registerOnboardingHandlers(store: Store): void {
  ipcMain.removeHandler('onboarding:get')
  ipcMain.removeHandler('onboarding:update')

  ipcMain.handle('onboarding:get', (): OnboardingState => store.getOnboarding())
  // Why: never trust renderer input — a compromised/buggy caller could send
  // unknown keys or wrong-typed values that would poison persisted state.
  // Run every update through the shared whitelist sanitizer.
  ipcMain.handle('onboarding:update', (_event, updates: unknown): OnboardingState => {
    const settingsBefore = store.getSettings()
    const wasDeferred = isManagedHookInstallDeferredForFirstRun({
      onboarding: store.getOnboarding(),
      settings: settingsBefore
    })
    const next = store.updateOnboarding(sanitizeOnboardingUpdate(updates))
    if (!wasDeferred) {
      return next
    }
    // Why the deferral-lifting transition and not the step-1 crossing: Esc and skip end the
    // deferral too, and by then the user has seen step 1 with the box in the state they left it.
    if (isManagedHookInstallDeferredForFirstRun({ onboarding: next, settings: settingsBefore })) {
      return next
    }
    // Idempotency comes from the latch, so a later wizard re-open never installs again.
    store.updateSettings({ managedAgentHookFirstRunGate: 'done' })
    const settings = store.getSettings()
    if (!isAgentStatusHooksEnabled(settings)) {
      return next
    }
    // Never awaited into the reply: presence detection hydrates the login-shell PATH in packaged
    // builds and can take seconds, and Continue is blocked on this reply.
    void installManagedAgentHooks(settings, {
      userInitiated: true,
      shouldHydrateShellPath: app.isPackaged,
      onInstallError: recordManagedHookInstallFailure
    }).catch((error: unknown) =>
      console.warn('[agent-hooks] first-run managed hook install failed:', error)
    )
    return next
  })
}
