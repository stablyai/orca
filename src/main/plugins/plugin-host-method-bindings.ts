import {
  getPluginHostMethodSpec,
  PLUGIN_HOST_API_V0,
  PLUGIN_TERMINAL_ID_MAX_LENGTH,
  PLUGIN_WORKSPACE_LABEL_MAX_LENGTH,
  PLUGIN_WORKSPACE_TERMINAL_LIMIT,
  type PluginHostMethodSpec
} from '../../shared/plugins/plugin-host-api'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'

export type PluginWorktreeContext = {
  worktreeId: string
  branch: string
  displayName: string
}

/** Structural service surface the facade delegates to. Desktop main binds it
 *  over runtime services; relay policy and conformance tests bind fakes. */
export type PluginHostServices = {
  resolveActiveWorktreeContext(): Promise<PluginWorktreeContext | null>
  listWorktreeTerminals(worktreeId: string): Promise<{ id: string }[]>
  sendTerminalText(
    terminalId: string,
    action: { text: string; enter: boolean }
  ): Promise<{ accepted: boolean }>
  dispatchPluginNotification(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }>
  storage: {
    get(pluginId: string, key: string): unknown
    set(pluginId: string, key: string, value: unknown): { ok: true } | { ok: false; error: string }
    delete(pluginId: string, key: string): void
    keys(pluginId: string): string[]
  }
  secrets: {
    get(
      pluginId: string,
      key: string
    ): { ok: true; value: string | null } | { ok: false; error: string }
    set(pluginId: string, key: string, value: string): { ok: true } | { ok: false; error: string }
    delete(pluginId: string, key: string): void
  }
  settings: {
    getAll(pluginId: string): Record<string, unknown>
    set(pluginId: string, key: string, value: unknown): { ok: true } | { ok: false; error: string }
  }
  subscribeEvents(pluginId: string, events: PluginEventName[]): PluginEventName[]
}

export type BoundPluginHostMethod = {
  spec: PluginHostMethodSpec
  handler: (
    params: unknown,
    ctx: { pluginId: string; services: PluginHostServices }
  ) => Promise<unknown>
}

function definePluginMethod(
  name: string,
  handler: BoundPluginHostMethod['handler']
): [string, BoundPluginHostMethod] {
  const spec = getPluginHostMethodSpec(name)
  if (!spec) {
    throw new Error(`no host API spec for method ${name}`)
  }
  return [name, { spec, handler }]
}

const HANDLERS = new Map<string, BoundPluginHostMethod>([
  definePluginMethod('workspace.readContext', async (_params, { services }) => {
    const context = await services.resolveActiveWorktreeContext()
    if (!context) {
      return null
    }
    const terminals = await services.listWorktreeTerminals(context.worktreeId)
    // Why: Orca worktree ids embed provider paths, so the public projection
    // must select safe fields instead of spreading the internal context.
    return {
      branch: context.branch.slice(0, PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
      displayName: context.displayName.slice(0, PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
      terminals: terminals
        .filter(
          (terminal) =>
            terminal.id.length > 0 && terminal.id.length <= PLUGIN_TERMINAL_ID_MAX_LENGTH
        )
        .slice(0, PLUGIN_WORKSPACE_TERMINAL_LIMIT)
        .map((terminal) => ({ id: terminal.id }))
    }
  }),
  definePluginMethod('terminal.sendText', async (params, { services }) => {
    const { terminalId, text, enter } = params as {
      terminalId: string
      text: string
      enter: boolean
    }
    const context = await services.resolveActiveWorktreeContext()
    if (!context) {
      throw new Error('no active worktree is available for terminal input')
    }
    // Why: terminal handles are provider-owned and can outlive focus changes;
    // re-list the resolved worktree immediately before routing plugin input.
    const terminals = await services.listWorktreeTerminals(context.worktreeId)
    if (!terminals.some((terminal) => terminal.id === terminalId)) {
      throw new Error('terminal is outside the active worktree')
    }
    const result = await services.sendTerminalText(terminalId, { text, enter })
    return { accepted: result.accepted }
  }),
  definePluginMethod('notifications.show', async (params, { pluginId, services }) => {
    const { title, body } = params as { title: string; body?: string }
    return services.dispatchPluginNotification({ pluginId, title, body })
  }),
  definePluginMethod('storage.get', async (params, { pluginId, services }) => {
    const { key } = params as { key: string }
    return { value: services.storage.get(pluginId, key) ?? null }
  }),
  definePluginMethod('storage.set', async (params, { pluginId, services }) => {
    const { key, value } = params as { key: string; value: unknown }
    const result = services.storage.set(pluginId, key, value)
    if (!result.ok) {
      throw new Error(result.error)
    }
    return { ok: true }
  }),
  definePluginMethod('storage.delete', async (params, { pluginId, services }) => {
    const { key } = params as { key: string }
    services.storage.delete(pluginId, key)
    return { ok: true }
  }),
  definePluginMethod('storage.keys', async (_params, { pluginId, services }) => {
    return { keys: services.storage.keys(pluginId) }
  }),
  definePluginMethod('secrets.get', async (params, { pluginId, services }) => {
    const { key } = params as { key: string }
    const result = services.secrets.get(pluginId, key)
    if (!result.ok) {
      throw new Error(result.error)
    }
    return { value: result.value }
  }),
  definePluginMethod('secrets.set', async (params, { pluginId, services }) => {
    const { key, value } = params as { key: string; value: string }
    const result = services.secrets.set(pluginId, key, value)
    if (!result.ok) {
      throw new Error(result.error)
    }
    return { ok: true }
  }),
  definePluginMethod('secrets.delete', async (params, { pluginId, services }) => {
    const { key } = params as { key: string }
    services.secrets.delete(pluginId, key)
    return { ok: true }
  }),
  definePluginMethod('settings.get', async (_params, { pluginId, services }) => {
    return { settings: services.settings.getAll(pluginId) }
  }),
  definePluginMethod('settings.set', async (params, { pluginId, services }) => {
    const { key, value } = params as { key: string; value: unknown }
    const result = services.settings.set(pluginId, key, value)
    if (!result.ok) {
      throw new Error(result.error)
    }
    return { ok: true }
  }),
  definePluginMethod('events.subscribe', async (params, { pluginId, services }) => {
    const { events } = params as { events: PluginEventName[] }
    return { subscribed: services.subscribeEvents(pluginId, events) }
  })
])

// Why: adding a facade schema without a binding must fail at module load,
// before a plugin can observe transport-specific behavior.
if (HANDLERS.size !== PLUGIN_HOST_API_V0.length) {
  throw new Error('plugin host API spec table and handler bindings are out of sync')
}

export function getBoundPluginHostMethod(name: string): BoundPluginHostMethod | null {
  return HANDLERS.get(name) ?? null
}
