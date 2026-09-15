import { app, ipcMain } from 'electron'
import { getCanonicalUserDataPath, sanitizeOnboardingUpdate, type Store } from '../persistence'
import {
  isManagedHookOnboardingPending,
  recordManagedHookOnboardingPassed
} from '../persistence/managed-hook-installation-marker'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import {
  installManagedAgentHooks,
  isAgentStatusHooksEnabled,
  shouldContinueManagedHookStartup
} from '../agent-hooks/managed-agent-hook-controls'
import { recordManagedHookInstallFailure } from '../agent-hooks/install-telemetry'

type OnboardingHandlerDeps = {
  /** Live quit flag, so a Continue-triggered install stops mid-loop on shutdown. */
  isQuitting?: () => boolean
}

function readAgentStatusHooksConsent(consent: unknown): boolean | undefined {
  if (typeof consent !== 'object' || consent === null) {
    return undefined
  }
  const value = (consent as { agentStatusHooksEnabled?: unknown }).agentStatusHooksEnabled
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Leaving counts as answering: an accidental Esc must not leave agent status permanently broken,
 * and by then the user has seen step 1 with the box in whatever state they left it.
 */
function hasMovedPastTheHooksQuestion(
  onboarding: Pick<OnboardingState, 'closedAt' | 'lastCompletedStep'>
): boolean {
  return onboarding.closedAt !== null || onboarding.lastCompletedStep >= 1
}

export function registerOnboardingHandlers(store: Store, deps: OnboardingHandlerDeps = {}): void {
  ipcMain.removeHandler('onboarding:get')
  ipcMain.removeHandler('onboarding:update')

  ipcMain.handle('onboarding:get', (): OnboardingState => store.getOnboarding())
  // Why: never trust renderer input — a compromised/buggy caller could send
  // unknown keys or wrong-typed values that would poison persisted state.
  // Run every update through the shared whitelist sanitizer.
  ipcMain.handle(
    'onboarding:update',
    (_event, updates: unknown, consent: unknown): OnboardingState => {
      const wasPending = isManagedHookOnboardingPending()
      // Why persist consent before advancing: the renderer's on-change write reports no failure, so
      // recording the answer on the default-on value would install for a user who unchecked. A
      // throw here aborts the advance too, keeping preference and marker from diverging.
      const consented = wasPending ? readAgentStatusHooksConsent(consent) : undefined
      if (consented !== undefined) {
        store.updateSettings({ agentStatusHooksEnabled: consented })
      }
      const next = store.updateOnboarding(sanitizeOnboardingUpdate(updates))
      if (!wasPending || !hasMovedPastTheHooksQuestion(next)) {
        return next
      }
      // Why the write must land first: a crash between "installed" and "recorded" is survivable,
      // but recording before an unchecked preference is durable would install against the box.
      if (!recordManagedHookOnboardingPassed(getCanonicalUserDataPath())) {
        return next
      }
      const settings = store.getSettings()
      if (!isAgentStatusHooksEnabled(settings)) {
        return next
      }
      // Never awaited into the reply: presence detection hydrates the login-shell PATH in packaged
      // builds and can take seconds, and Continue is blocked on this reply. No `userInitiated`:
      // this stands in for the startup install, which leaves a deliberate empty hooks.json alone.
      void installManagedAgentHooks(settings, {
        shouldHydrateShellPath: app.isPackaged,
        onInstallError: recordManagedHookInstallFailure,
        // Why: the un-awaited loop outlives the user reaching Settings and unchecking, and without
        // this it re-adds entries removeManagedAgentHooks() has already swept.
        shouldContinue: (agent) =>
          shouldContinueManagedHookStartup(deps.isQuitting?.() === true, store.getSettings(), agent)
      }).catch((error: unknown) =>
        console.warn('[agent-hooks] first-run managed hook install failed:', error)
      )
      return next
    }
  )
}
