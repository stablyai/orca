/** Chat naming runs on the host, so a WSL host follows this desktop's "Name chats automatically" switch. */
import { HOST_CHAT_AUTO_NAME_SETTING_RUNTIME_CAPABILITY } from '../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'
import type { WslOrcadHostAccountPush } from './wsl-orcad-host-account-push'

const pending = new Map<string, Promise<void>>()

/** Serialized per host and read when sent, so quick toggles land in order with the latest value. */
export function pushWslOrcadHostChatAutoName(
  push: Pick<WslOrcadHostAccountPush, 'environmentId' | 'hostSupports' | 'call'>,
  readAutoName: () => boolean
): Promise<void> {
  return runKeyedSerializedOperation(pending, push.environmentId, async () => {
    // An older host refuses the key (settings.update is strict); the next ready retries an unknown.
    if ((await push.hostSupports(HOST_CHAT_AUTO_NAME_SETTING_RUNTIME_CAPABILITY)) !== 'supported') {
      return
    }
    const response = await push.call('settings.update', { nativeChatAutoName: readAutoName() })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
  })
}
