import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../../../transport/rpc/rpc-operation-contract'
import '../../../../../src/shared/source-control/listing/source-control-group-order'
import { settingsMember, settingsField } from '../../../settings/mobile-settings-projection'

// Missing reports let the caller tell an older host's absence from a reported value.
function reportedBooleanSettingReader<Variant extends string>(
  key: string,
  variant: Variant
): RpcCompatibleReader<unknown, Variant, boolean | null> {
  return (raw) => {
    const settings = raw == null ? undefined : settingsMember(raw)
    const value = settings == null ? undefined : settingsField(settings, key)
    return {
      compatible: true,
      variant,
      value: typeof value === 'boolean' ? value : null,
      salvage: { droppedPaths: [], droppedCount: 0 }
    }
  }
}

export const nativeChatQueueFollowUpsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.native-chat-follow-up-behavior-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: reportedBooleanSettingReader('nativeChatQueueFollowUps', 'follow-up-behavior')
  })
)

export const nativeChatCiResultLinesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.native-chat-ci-result-lines-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: reportedBooleanSettingReader('nativeChatCiResultLines', 'ci-result-lines')
  })
)
