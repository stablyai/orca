import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc/rpc-operation-contract'
import '../../../src/shared/source-control/listing/source-control-group-order'
import { settingsMember, settingsField } from '../settings/mobile-settings-projection'

type HostListSettings = {
  showPinnedWorktreesInGroups: boolean
  compactWorktreeCards: boolean
  newCardStyle: boolean
}

// Older hosts omit these settings; only explicit true overrides their disabled defaults.
const hostListSettingsReader: RpcCompatibleReader<
  unknown,
  'host-list-settings',
  HostListSettings
> = (raw) => {
  const settings = raw == null ? undefined : settingsMember(raw)
  const isOn = (key: string) => settings != null && settingsField(settings, key) === true
  return {
    compatible: true,
    variant: 'host-list-settings',
    value: {
      showPinnedWorktreesInGroups: isOn('showPinnedWorktreesInGroups'),
      compactWorktreeCards: isOn('compactWorktreeCards'),
      newCardStyle: isOn('experimentalNewWorktreeCardStyle')
    },
    salvage: { droppedPaths: [], droppedCount: 0 }
  }
}

export const hostListSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.host-list-settings-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: hostListSettingsReader
  })
)
