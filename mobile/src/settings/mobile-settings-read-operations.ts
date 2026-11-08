import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc/rpc-operation-contract'
import '../../../src/shared/source-control/listing/source-control-group-order'
import { settingsMember } from './mobile-settings-projection'

// Keep settings opaque because callers retain fields without validating their shapes.
const settingsReader: RpcCompatibleReader<unknown, 'settings-member', unknown> = (raw) => ({
  compatible: true,
  variant: 'settings-member',
  value: settingsMember(raw),
  salvage: { droppedPaths: [], droppedCount: 0 }
})

const optionalSettingsReader: RpcCompatibleReader<unknown, 'optional-settings-member', unknown> = (
  raw
) => ({
  compatible: true,
  variant: 'optional-settings-member',
  value: raw == null ? undefined : settingsMember(raw),
  salvage: { droppedPaths: [], droppedCount: 0 }
})

/** Submit, task hydration/create and home providers: a null result throws the settings read. */
export const settingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.member-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: settingsReader
  })
)

/** Workspace context, history resume and repo metadata: a null result reads as absent settings. */
export const optionalSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.optional-member-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: optionalSettingsReader
  })
)
