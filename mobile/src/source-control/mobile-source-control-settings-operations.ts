import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc/rpc-operation-contract'
import { normalizeSourceControlGroupOrder } from '../../../src/shared/source-control/listing/source-control-group-order'
import type { SourceControlGroupOrder } from '../../../src/shared/ui-chrome-types'
import { settingsMember, settingsField } from '../settings/mobile-settings-projection'

export type MobileSourceControlSettings = {
  groupOrder: SourceControlGroupOrder
  compareAgainstUpstream: boolean
  diffShowWhitespace: boolean
}

// Older hosts omit these settings; absence reads as desktop's defaults.
const sourceControlSettingsReader: RpcCompatibleReader<
  unknown,
  'source-control-settings',
  MobileSourceControlSettings
> = (raw) => {
  const settings = raw == null ? undefined : settingsMember(raw)
  const field = (key: string) => (settings == null ? undefined : settingsField(settings, key))
  return {
    compatible: true,
    variant: 'source-control-settings',
    value: {
      groupOrder: normalizeSourceControlGroupOrder(field('sourceControlGroupOrder')),
      compareAgainstUpstream: field('sourceControlCompareAgainstUpstream') === true,
      diffShowWhitespace: field('diffShowWhitespace') === true
    },
    salvage: { droppedPaths: [], droppedCount: 0 }
  }
}

export const sourceControlSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.source-control-settings-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: sourceControlSettingsReader
  })
)
