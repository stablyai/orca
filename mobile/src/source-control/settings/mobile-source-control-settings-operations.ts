import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../../transport/rpc/rpc-operation-contract'
import { normalizeSourceControlGroupOrder } from '../../../../src/shared/source-control/listing/source-control-group-order'
import type { SourceControlGroupOrder } from '../../../../src/shared/ui-chrome-types'
import { settingsMember, settingsField } from '../../settings/mobile-settings-projection'
import {
  normalizePRAutoRefreshCadence,
  type PRAutoRefreshCadence
} from '../../../../src/shared/review-refresh-policy'

export type MobileSourceControlSettings = {
  groupOrder: SourceControlGroupOrder
  compareAgainstUpstream: boolean
  diffShowWhitespace: boolean
  /** The host's PR auto-refresh cadence; the PR screen's own timer follows it. */
  prAutoRefresh: PRAutoRefreshCadence
}

const SOURCE_CONTROL_SETTING = {
  groupOrder: 'sourceControlGroupOrder',
  compareAgainstUpstream: 'sourceControlCompareAgainstUpstream',
  diffShowWhitespace: 'diffShowWhitespace',
  prAutoRefresh: 'prAutoRefresh'
} as const

export const SOURCE_CONTROL_SETTINGS_KEYS: readonly string[] = Object.values(SOURCE_CONTROL_SETTING)

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
      groupOrder: normalizeSourceControlGroupOrder(field(SOURCE_CONTROL_SETTING.groupOrder)),
      compareAgainstUpstream: field(SOURCE_CONTROL_SETTING.compareAgainstUpstream) === true,
      diffShowWhitespace: field(SOURCE_CONTROL_SETTING.diffShowWhitespace) === true,
      prAutoRefresh: normalizePRAutoRefreshCadence(field(SOURCE_CONTROL_SETTING.prAutoRefresh))
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
