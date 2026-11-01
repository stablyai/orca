import {
  isPluginHostMethodName,
  PLUGIN_HOST_API,
  PLUGIN_HOST_METHOD_NAMES,
  type PluginHostMethodName,
  type PluginJsonValue
} from '../../../shared/plugins/workers/plugin-host-api'
import {
  projectPluginWorkspaceAgents,
  projectPluginWorkspaceContext,
  type PluginAgentStatusRow,
  type PluginWorkspaceTerminal
} from './plugin-workspace-projection'
import type { PluginHostCallScope } from './plugin-host-call-scope'
import type { PluginDataArea } from '../../../shared/plugins/workers/plugin-panel-bridge-protocol'
import {
  PLUGIN_PANEL_BRIDGE_HANDLERS,
  type PluginPanelBridgeServices
} from './plugin-host-panel-method-bindings'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'

export type { PluginHostCallScope } from './plugin-host-call-scope'

export type PluginWorktreeContext = {
  worktreeId: string
  branch: string
  displayName: string
}

/** Desktop-only sinks for frame methods; absent in headless serve. */
export type PluginDesktopFrameServices = {
  openExternal(
    pluginId: string,
    url: string,
    scope: PluginHostCallScope
  ): Promise<{ opened: boolean; reason?: 'cancelled' | 'consent-unavailable' }>
  /** False when the person cancelled the dialog. */
  saveFile(
    pluginId: string,
    input: { suggestedName?: string; mimeType?: string; data: string | ArrayBuffer | Uint8Array },
    scope: PluginHostCallScope
  ): Promise<boolean>
}

export type PluginHostServices = {
  resolveActiveWorktreeContext(): Promise<PluginWorktreeContext | null>
  listWorktreeTerminals(worktreeId: string): Promise<PluginWorkspaceTerminal[]>
  listAgentStatuses(): readonly PluginAgentStatusRow[]
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
    get(pluginId: string, key: string): PluginJsonValue | undefined
    set(
      pluginId: string,
      key: string,
      value: PluginJsonValue
    ): { ok: true } | { ok: false; error: string }
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
    protection(): 'os-keyring' | 'unavailable'
  }
  desktop?: PluginDesktopFrameServices | null
  /** The plugin's open panels and its worker; absent where no panel host runs. */
  panels?: PluginPanelBridgeServices | null
  settings: {
    getAll(pluginId: string): Record<string, PluginJsonValue>
    set(
      pluginId: string,
      key: string,
      value: PluginJsonValue
    ): { ok: true } | { ok: false; error: string }
  }
}

export type {
  BoundPluginHostMethod,
  PluginHostMethodContext,
  PreparedPluginHostCall
} from './plugin-host-method-bind'

const api = PLUGIN_HOST_API
const OK = { ok: true } as const

const HANDLERS: Record<PluginHostMethodName, BoundPluginHostMethod> = {
  'workspace.readContext': bind(api['workspace.readContext'], async (_params, { services }) => {
    const context = await services.resolveActiveWorktreeContext()
    const terminals = context ? await services.listWorktreeTerminals(context.worktreeId) : []
    return projectPluginWorkspaceContext(context, terminals)
  }),
  'agents.list': bind(api['agents.list'], async (_params, { services }) => {
    const context = await services.resolveActiveWorktreeContext()
    if (!context) {
      return { agents: [] }
    }
    const terminals = await services.listWorktreeTerminals(context.worktreeId)
    return {
      agents: projectPluginWorkspaceAgents(
        context.worktreeId,
        terminals,
        services.listAgentStatuses()
      )
    }
  }),
  'terminal.sendText': bind(api['terminal.sendText'], async (params, { services, scope }) => {
    const context = await services.resolveActiveWorktreeContext()
    if (!context) {
      throw new Error('no active worktree is available for terminal input')
    }
    // Handles outlive focus changes; revalidate current workspace membership before terminal input.
    const terminals = await services.listWorktreeTerminals(context.worktreeId)
    if (!terminals.some((terminal) => terminal.id === params.terminalId)) {
      throw new Error('terminal is outside the active worktree')
    }
    const { text, enter } = params
    scope.assertActive()
    const result = await services.sendTerminalText(params.terminalId, { text, enter })
    return { accepted: result.accepted }
  }),
  'notifications.show': bind(api['notifications.show'], async (params, { pluginId, services }) =>
    services.dispatchPluginNotification({ pluginId, title: params.title, body: params.body })
  ),
  'storage.get': bind(api['storage.get'], async ({ key }, { pluginId, services }) => ({
    value: services.storage.get(pluginId, key) ?? null
  })),
  'storage.set': bind(api['storage.set'], async ({ key, value }, { pluginId, services }) =>
    changed(
      services,
      pluginId,
      'storage',
      key,
      okOrThrow(services.storage.set(pluginId, key, value))
    )
  ),
  'storage.delete': bind(api['storage.delete'], async ({ key }, { pluginId, services }) => {
    services.storage.delete(pluginId, key)
    return changed(services, pluginId, 'storage', key, OK)
  }),
  'storage.keys': bind(api['storage.keys'], async (_params, { pluginId, services }) => ({
    keys: services.storage.keys(pluginId)
  })),
  'secrets.get': bind(api['secrets.get'], async ({ key }, { pluginId, services }) => {
    const result = services.secrets.get(pluginId, key)
    if (!result.ok) {
      throw new Error(result.error)
    }
    return { value: result.value }
  }),
  'secrets.set': bind(api['secrets.set'], async ({ key, value }, { pluginId, services }) =>
    okOrThrow(services.secrets.set(pluginId, key, value))
  ),
  'secrets.delete': bind(api['secrets.delete'], async ({ key }, { pluginId, services }) => {
    services.secrets.delete(pluginId, key)
    return OK
  }),
  'secrets.protection': bind(api['secrets.protection'], async (_params, { services }) => ({
    status: services.secrets.protection()
  })),
  'settings.get': bind(api['settings.get'], async (_params, { pluginId, services }) => ({
    settings: services.settings.getAll(pluginId)
  })),
  'settings.set': bind(api['settings.set'], async ({ key, value }, { pluginId, services }) =>
    changed(
      services,
      pluginId,
      'settings',
      key,
      okOrThrow(services.settings.set(pluginId, key, value))
    )
  ),
  'shell.openExternal': bind(
    api['shell.openExternal'],
    async ({ url }, { pluginId, services, scope }) =>
      requireDesktop(services).openExternal(pluginId, url, scope)
  ),
  'files.saveAs': bind(api['files.saveAs'], async (params, { pluginId, services, scope }) => {
    const saved = await requireDesktop(services).saveFile(pluginId, params, scope)
    return { status: saved ? ('saved' as const) : ('cancelled' as const) }
  }),
  ...PLUGIN_PANEL_BRIDGE_HANDLERS
}

function requireDesktop(services: PluginHostServices): PluginDesktopFrameServices {
  if (!services.desktop) {
    throw new Error('this method is only available in the Orca desktop app')
  }
  return services.desktop
}

/** Tells the plugin's panels and worker after a write lands. */
function changed<T>(
  services: PluginHostServices,
  pluginId: string,
  area: PluginDataArea,
  key: string,
  result: T
): T {
  services.panels?.dataChanged(pluginId, area, key)
  return result
}

function okOrThrow(result: { ok: true } | { ok: false; error: string }): typeof OK {
  if (!result.ok) {
    throw new Error(result.error)
  }
  return OK
}

// Why: adding a facade schema without a binding must fail at module load,
// before a plugin can observe transport-specific behavior.
for (const name of PLUGIN_HOST_METHOD_NAMES) {
  if (HANDLERS[name].spec !== PLUGIN_HOST_API[name]) {
    throw new Error(`plugin host API binding for ${name} uses another method's spec`)
  }
}

export function getBoundPluginHostMethod(name: string): BoundPluginHostMethod | null {
  return isPluginHostMethodName(name) ? HANDLERS[name] : null
}
