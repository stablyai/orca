/** Chat naming runs on the host, so a WSL host follows this desktop's chat naming switches. */
import {
  HOST_ANTIGRAVITY_CHAT_NAMING_SETTING_RUNTIME_CAPABILITY,
  HOST_CHAT_AUTO_NAME_SETTING_RUNTIME_CAPABILITY
} from '../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import type { WslOrcadHostAccountPush } from './wsl-orcad-host-account-push'
import {
  createWslOrcadHostPushQueue,
  pushToWslOrcadHostWithRetry,
  WSL_HOST_PUSH_RETRY_DELAYS_MS
} from './wsl-orcad-host-push-retry'

const queue = createWslOrcadHostPushQueue()

export type WslHostChatNaming = { nativeChatAutoName: boolean; antigravityChatNaming: boolean }

/** Reads the switches when sent, so quick toggles end on the latest values. */
export function pushWslOrcadHostChatAutoName(
  push: Pick<WslOrcadHostAccountPush, 'environmentId' | 'hostSupports' | 'call'>,
  readNaming: () => WslHostChatNaming,
  retryDelaysMs: readonly number[] = WSL_HOST_PUSH_RETRY_DELAYS_MS
): Promise<void> {
  return pushToWslOrcadHostWithRetry(
    queue,
    push.environmentId,
    async () => {
      // One after the other, so the second reads the status the first cached.
      const verdicts = [
        await push.hostSupports(HOST_CHAT_AUTO_NAME_SETTING_RUNTIME_CAPABILITY),
        await push.hostSupports(HOST_ANTIGRAVITY_CHAT_NAMING_SETTING_RUNTIME_CAPABILITY)
      ]
      if (verdicts.includes('unknown')) {
        // Unknown capabilities are not proof of an old host; fail so the push retries.
        throw new Error('The host did not report its capabilities.')
      }
      const [autoName, antigravity] = verdicts.map((verdict) => verdict === 'supported')
      // An older host refuses a key it doesn't know (settings.update is strict).
      const naming = readNaming()
      const updates = {
        ...(autoName ? { nativeChatAutoName: naming.nativeChatAutoName } : {}),
        ...(antigravity ? { antigravityChatNaming: naming.antigravityChatNaming } : {})
      }
      if (Object.keys(updates).length === 0) {
        return
      }
      const response = await push.call('settings.update', updates)
      if (!response.ok) {
        throw new Error(response.error.message)
      }
    },
    (error) => {
      console.warn(`[wsl-hosts] Could not copy chat naming to ${push.environmentId}:`, error)
    },
    retryDelaysMs
  )
}
