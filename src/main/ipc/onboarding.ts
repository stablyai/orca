import { removeAppHandler, registerAppHandler } from './app-registry/app-handler-registry'

import { sanitizeOnboardingUpdate } from '../persistence/applying-settings/onboarding-normalization'
import type { Store } from '../persistence/loading-store/store'
import type { OnboardingState } from '../../shared/onboarding/onboarding-state-types'
import type { ChatUiLaunchTipVariant } from '../../shared/feature-education/chat-ui-launch-tip-audience'
import { isChatUiLaunchTipDeferredForConsent } from '../telemetry/chat-ui-launch-tip-cohort'

export function registerOnboardingHandlers(store: Store): void {
  removeAppHandler('onboarding:get')
  removeAppHandler('onboarding:update')
  removeAppHandler('onboarding:getChatUiLaunchTipVariant')

  registerAppHandler('onboarding:get', (): OnboardingState => store.getOnboarding())
  // Sanitize untyped IPC keys and values before persisting onboarding state.
  registerAppHandler('onboarding:update', (_event, updates: unknown): OnboardingState => {
    return store.updateOnboarding(sanitizeOnboardingUpdate(updates))
  })
  // 'none' skips the tip this launch without marking it seen, so it returns once consent resolves.
  registerAppHandler('onboarding:getChatUiLaunchTipVariant', (): ChatUiLaunchTipVariant =>
    isChatUiLaunchTipDeferredForConsent() ? 'none' : store.getChatUiLaunchTipVariant()
  )
}
