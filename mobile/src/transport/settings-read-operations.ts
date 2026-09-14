import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import type { RpcCompatibleReader } from './rpc-operation-contract'

function settingsMember(raw: unknown): unknown {
  const boxed: { readonly settings?: unknown } | null | undefined = raw == null ? raw : Object(raw)
  // Preserve the native engine's existing property-read exception on null/undefined.
  return boxed!.settings
}

// Settings remain opaque: callers historically retain fields without validating their shapes.
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

const botOverridesReader: RpcCompatibleReader<unknown, 'bot-logins', string[]> = (raw) => {
  const settings = raw == null ? undefined : settingsMember(raw)
  const overrides: unknown =
    settings == null ? undefined : Reflect.get(Object(settings), 'prBotAuthorOverrides')
  return {
    compatible: true,
    variant: 'bot-logins',
    value: Array.isArray(overrides)
      ? overrides.filter((login): login is string => typeof login === 'string')
      : [],
    salvage: { droppedPaths: [], droppedCount: 0 }
  }
}

/** Workspace context, submit, task hydration/create and home providers share this acceptance. */
export const settingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.member-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: settingsReader
  })
)

/** History resume and repo labels historically tolerate an absent or null result. */
export const optionalSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.optional-member-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: optionalSettingsReader
  })
)

// New-tab checks the sibling's refusal before touching settings, but after its own refusal.
const newTabSettingsReader: RpcCompatibleReader<
  unknown,
  'deferred-settings-member',
  () => unknown
> = (raw) => ({
  compatible: true,
  variant: 'deferred-settings-member',
  value: () => settingsMember(raw),
  salvage: { droppedPaths: [], droppedCount: 0 }
})

export const newTabSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.new-tab-message-error',
    method: 'settings.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: newTabSettingsReader
  })
)

export const botOverridesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.bot-logins-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: botOverridesReader
  })
)
