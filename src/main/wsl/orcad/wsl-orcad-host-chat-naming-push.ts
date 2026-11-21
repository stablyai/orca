/** Chat naming runs on the host, so a WSL host follows this desktop's "Name chats automatically" switch. */
import { HOST_CHAT_AUTO_NAME_SETTING_RUNTIME_CAPABILITY } from '../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import type { WslOrcadHostAccountPush } from './wsl-orcad-host-account-push'
import {
  createWslOrcadHostPushQueue,
  pushToWslOrcadHostWithRetry,
  WSL_HOST_PUSH_RETRY_DELAYS_MS
} from './wsl-orcad-host-push-retry'

const queue = createWslOrcadHostPushQueue()

/** Reads the switch when sent, so quick toggles end on the latest value. */
export function pushWslOrcadHostChatAutoName(
  push: Pick<WslOrcadHostAccountPush, 'environmentId' | 'hostSupports' | 'call'>,
  readAutoName: () => boolean,
  retryDelaysMs: readonly number[] = WSL_HOST_PUSH_RETRY_DELAYS_MS
): Promise<void> {
  return pushToWslOrcadHostWithRetry(
    queue,
    push.environmentId,
    async () => {
      const verdict = await push.hostSupports(HOST_CHAT_AUTO_NAME_SETTING_RUNTIME_CAPABILITY)
      if (verdict === 'unknown') {
        // Unknown capabilities are not proof of an old host; fail so the push retries.
        throw new Error('The host did not report its capabilities.')
      }
      // An older host refuses the key (settings.update is strict).
      if (verdict === 'unsupported') {
        return
      }
      const response = await push.call('settings.update', { nativeChatAutoName: readAutoName() })
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
