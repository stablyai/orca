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

const copyTrimsGutterReader: RpcCompatibleReader<unknown, 'copy-trims-gutter', boolean> = (raw) => {
  const settings = raw == null ? undefined : settingsMember(raw)
  const trims: unknown =
    settings == null ? undefined : Reflect.get(Object(settings), 'terminalCopyTrimsGutter')
  return {
    compatible: true,
    variant: 'copy-trims-gutter',
    // Why `!== false`: a host predating the setting sends no key, and the
    // desktop default is on, so absence must read as on.
    value: trims !== false,
    salvage: { droppedPaths: [], droppedCount: 0 }
  }
}

export const terminalCopyTrimsGutterRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.terminal-copy-trims-gutter-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: copyTrimsGutterReader
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
