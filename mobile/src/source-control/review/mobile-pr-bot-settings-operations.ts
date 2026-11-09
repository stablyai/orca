import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../../transport/rpc/rpc-operation-contract'
import '../../../../src/shared/source-control/listing/source-control-group-order'
import { settingsMember, settingsField } from '../../settings/mobile-settings-projection'

const botOverridesReader: RpcCompatibleReader<unknown, 'bot-logins', string[]> = (raw) => {
  const settings = raw == null ? undefined : settingsMember(raw)
  const overrides: unknown =
    settings == null ? undefined : settingsField(settings, 'prBotAuthorOverrides')
  return {
    compatible: true,
    variant: 'bot-logins',
    value: Array.isArray(overrides)
      ? overrides.filter((login): login is string => typeof login === 'string')
      : [],
    salvage: { droppedPaths: [], droppedCount: 0 }
  }
}

export const botOverridesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.bot-logins-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: botOverridesReader
  })
)
