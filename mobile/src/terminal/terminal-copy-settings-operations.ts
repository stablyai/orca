import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc/rpc-operation-contract'
import '../../../src/shared/source-control/listing/source-control-group-order'
import { settingsMember, settingsField } from '../settings/mobile-settings-projection'

function onByDefaultSettingReader<Variant extends string>(
  key: string,
  variant: Variant
): RpcCompatibleReader<unknown, Variant, boolean> {
  return (raw) => {
    const settings = raw == null ? undefined : settingsMember(raw)
    const value: unknown = settings == null ? undefined : settingsField(settings, key)
    return {
      compatible: true,
      variant,
      // Older hosts omit these settings; absence inherits the desktop’s enabled default.
      value: value !== false,
      salvage: { droppedPaths: [], droppedCount: 0 }
    }
  }
}

export const terminalCopyTrimsGutterRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.terminal-copy-trims-gutter-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: onByDefaultSettingReader('terminalCopyTrimsGutter', 'copy-trims-gutter')
  })
)
