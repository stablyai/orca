import type { MobilePushPrompt } from '../../../shared/notifications/mobile-push-contract'
import { pushPromptForPane } from '../agent-prompt/agent-prompt-sources'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import type { PushGatewayClient } from './push-gateway-client'
import { PushPromptCategoryGate } from './push-prompt-category-gate'

export type DesktopPushPrompt = {
  gate: PushPromptCategoryGate
  promptFor: (event: MobileNotificationEvent) => MobilePushPrompt | null
}

export function desktopPushPrompt(
  runtime: OrcaRuntimeService,
  client: PushGatewayClient
): DesktopPushPrompt {
  return {
    gate: new PushPromptCategoryGate(() =>
      typeof client.readPromptCategory === 'function'
        ? client.readPromptCategory()
        : Promise.resolve(false)
    ),
    promptFor: (event) => {
      if (event.type !== 'notification' || !event.paneKey) {
        return null
      }
      try {
        return pushPromptForPane(runtime, event.paneKey)
      } catch (error) {
        console.warn('[push] pending prompt lookup failed', error)
        return null
      }
    }
  }
}
