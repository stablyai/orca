import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../../../transport/rpc/rpc-operation-contract'
import '../../../../../src/shared/source-control/listing/source-control-group-order'
import { settingsMember, settingsField } from '../../../settings/mobile-settings-projection'

// Missing reports let the caller preserve the older host's existing preference source.
const followUpBehaviorReader: RpcCompatibleReader<unknown, 'follow-up-behavior', boolean | null> = (
  raw
) => {
  const settings = raw == null ? undefined : settingsMember(raw)
  const value = settings == null ? undefined : settingsField(settings, 'nativeChatQueueFollowUps')
  return {
    compatible: true,
    variant: 'follow-up-behavior',
    value: typeof value === 'boolean' ? value : null,
    salvage: { droppedPaths: [], droppedCount: 0 }
  }
}

export const nativeChatQueueFollowUpsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.native-chat-follow-up-behavior-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: followUpBehaviorReader
  })
)
