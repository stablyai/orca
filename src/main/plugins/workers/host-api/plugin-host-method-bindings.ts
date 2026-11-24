import { z } from 'zod'
import {
  isPluginHostMethodName,
  PLUGIN_HOST_API,
  PLUGIN_HOST_METHOD_NAMES,
  type PluginHostMethodName,
} from '../../../../shared/plugins/workers/plugin-host-api'
import {
  projectPluginWorkspaceAgents,
  pluginFrameWorkspaceContext,
  projectPluginWorkspaceContext
} from './plugin-workspace-projection'
import type { PluginDataArea } from '../../../../shared/plugins/workers/plugin-panel-bridge-protocol'
import {
  PLUGIN_PANEL_BRIDGE_HANDLERS
} from './plugin-host-panel-method-bindings'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import {
  PLUGIN_STATUS_BAR_HANDLERS
} from './plugin-host-status-bar-method-bindings'
import { PLUGIN_WORKSPACE_ACTION_HANDLERS } from './plugin-host-workspace-method-bindings'
import { PLUGIN_TERMINAL_ACTION_HANDLERS } from './plugin-host-terminal-method-bindings'
import { PLUGIN_WORKSPACE_CREATE_HANDLERS } from './plugin-host-workspace-create-bindings'
import { PLUGIN_AUTOMATION_HANDLERS } from './plugin-host-automation-bindings'
import { PLUGIN_AGENT_HISTORY_HANDLERS } from './plugin-host-agent-history-bindings'
import { PLUGIN_PROJECT_VISIBILITY_HANDLERS } from './plugin-host-project-visibility-binding'
import {
  pluginHostRpc as rpc,
  pluginWorkspaceSelector as workspaceSelector
} from './plugin-host-runtime-call'
import { PluginHostCallError } from './plugin-host-call-scope'

import type { PluginDesktopFrameServices, PluginHostServices } from './plugin-host-services-types'

export type {
  PluginDesktopFrameServices,
  PluginHostServices,
  PluginWorktreeContext
} from './plugin-host-services-types'

const api = PLUGIN_HOST_API

const worktreeShowAnswer = z.object({ worktree: z.object({ id: z.string() }) })
const OK = { ok: true } as const

const HANDLERS: Record<PluginHostMethodName, BoundPluginHostMethod> = {
  'settings.open': bind(api['settings.open'], async (_params, { pluginId, services, scope }) => {
    if (!services.hasSettingsPage || !services.renderer?.openPluginSettings) {
      throw new PluginHostCallError(
        'unavailable',
        'this plugin has no settings page available in an Orca window'
      )
    }
    scope.assertActive()
    await services.renderer.openPluginSettings(pluginId)
    return { opened: true as const }
  }),
  'appearance.read': bind(api['appearance.read'], async (_params, { services }) => {
    if (!services.appearance) {
      throw new PluginHostCallError('unavailable', 'desktop appearance service is unavailable')
    }
    return services.appearance.read()
  }),
  'appearance.apply': bind(
    api['appearance.apply'],
    async (params, { pluginId, services, scope }) => {
      if (!services.appearance) {
        throw new PluginHostCallError('unavailable', 'desktop appearance service is unavailable')
      }
      return services.appearance.apply(pluginId, params, scope)
    }
  ),
  'editor.readTypography': bind(api['editor.readTypography'], async (_params, { services }) => {
    if (!services.editorTypography) {
      throw new PluginHostCallError('unavailable', 'editor settings are unavailable on this host')
    }
    return services.editorTypography.read()
  }),
  'workspace.readContext': bind(
    api['workspace.readContext'],
    async (_params, { services, surface }) => {
      const context = await services.resolveActiveWorktreeContext()
      // A remote host may be unreachable; its workspace context still exists, so omit only its terminals.
      const terminals = context
        ? await services.listWorktreeTerminals(context.worktreeId).catch(() => [])
        : []
      const projected = projectPluginWorkspaceContext(context, terminals)
      return surface === 'worker' ? projected : pluginFrameWorkspaceContext(projected)
    }
  ),
  'agents.list': bind(api['agents.list'], async (params, { services, scope }) => {
    const worktreeId = params?.workspaceId
      ? worktreeShowAnswer.parse(
          await rpc(services)(
            'worktree.show',
            { worktree: workspaceSelector(params.workspaceId), matchFolderWorkspaces: true },
            scope.signal ? { signal: scope.signal } : {}
          )
        ).worktree.id
      : (await services.resolveActiveWorktreeContext())?.worktreeId
    if (!worktreeId) {
      return { agents: [] }
    }
    const terminals = await services.listWorktreeTerminals(worktreeId).catch(() => [])
    return {
      agents: projectPluginWorkspaceAgents(
        worktreeId,
        terminals,
        services.listAgentStatuses(),
        // Only read when the workspace has agents: it reads the orchestration database.
        () => services.listAgentTaskTitles?.() ?? new Map()
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
  ...PLUGIN_PANEL_BRIDGE_HANDLERS,
  ...PLUGIN_STATUS_BAR_HANDLERS,
  ...PLUGIN_WORKSPACE_ACTION_HANDLERS,
  ...PLUGIN_PROJECT_VISIBILITY_HANDLERS,
  ...PLUGIN_TERMINAL_ACTION_HANDLERS,
  ...PLUGIN_WORKSPACE_CREATE_HANDLERS,
  ...PLUGIN_AUTOMATION_HANDLERS,
  ...PLUGIN_AGENT_HISTORY_HANDLERS
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
  if (area === 'settings') {
    services.panels?.dataChanged(pluginId, area, key, 'plugin')
  } else {
    services.panels?.dataChanged(pluginId, area, key)
  }
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
