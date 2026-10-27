import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import type { RpcCompatibleReader } from './rpc-operation-contract'
import { normalizeSourceControlGroupOrder } from '../../../src/shared/source-control-group-order'
import type { SourceControlGroupOrder } from '../../../src/shared/ui-chrome-types'

function settingsMember(raw: unknown): unknown {
  const boxed: { readonly settings?: unknown } | null | undefined = raw == null ? raw : Object(raw)
  // Preserve the native engine's existing property-read exception on null/undefined.
  return boxed!.settings
}

// Box primitives so a non-object settings value reads as absent instead of throwing.
function settingsField(settings: unknown, key: string): unknown {
  const boxed: Record<string, unknown> = Object(settings)
  return boxed[key]
}

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
    settings == null ? undefined : settingsField(settings, 'terminalCopyTrimsGutter')
  return {
    compatible: true,
    variant: 'copy-trims-gutter',
    // Older hosts omit this setting; absence inherits the desktop’s enabled default.
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

export const botOverridesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.bot-logins-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: botOverridesReader
  })
)
