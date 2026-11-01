import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../../shared/plugins/workers/plugin-host-api'
import type { PluginHostServices } from './plugin-host-methods'
import type { PluginDesktopFrameServices } from './plugin-host-method-bindings'
import type { PluginPanelBridgeServices } from './plugin-host-panel-method-bindings'
import {
  pluginSettingValueIssue,
  type PluginSettingContribution
} from '../../../shared/plugins/contributions/plugin-settings-contribution'
import { pluginSettingDefaults } from '../../../shared/plugins/contributions/plugin-settings-values'
import { PluginSecretsStore, pluginSecretsProtection } from '../plugin-secrets-store'
import { PluginKvStore } from '../plugin-storage-store'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { pluginTerminalTitle, type PluginAgentStatusRow } from './plugin-workspace-projection'

export type PluginRuntimeDelegate = {
  resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null>
  listTerminals(
    worktreeSelector?: string,
    limit?: number,
    opts?: { includeVisualLayouts?: boolean }
  ): Promise<{
    terminals: {
      handle: string
      title: string | null
      paneTitle?: string
      tabId?: string
      leafId?: string
    }[]
  }>
  sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean },
    options: { inputKind: TerminalInputKind }
  ): Promise<{ accepted: boolean }>
  dispatchPluginNotification(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }>
  /** The hook server's agent rows; absent where no hook server runs. */
  listAgentStatuses?(): readonly PluginAgentStatusRow[]
}

export function bindPluginHostServices(input: {
  delegate: PluginRuntimeDelegate
  pluginsDataDir: string
  desktop?: PluginDesktopFrameServices | null
  panels?: PluginPanelBridgeServices | null
  /** The calling plugin's `contributes.settings`: defaults and value checks. */
  declaredSettings?: readonly PluginSettingContribution[]
}): PluginHostServices {
  const declared = new Map((input.declaredSettings ?? []).map((setting) => [setting.key, setting]))
  const { delegate, pluginsDataDir } = input
  return {
    desktop: input.desktop ?? null,
    panels: input.panels ?? null,
    resolveActiveWorktreeContext: async () => {
      const context = await delegate.resolveActiveWorktreeContext()
      if (!context) {
        return null
      }
      // Retain path-bearing worktree IDs for host membership checks; public projections exclude them.
      return {
        worktreeId: context.worktreeId,
        branch: context.branch,
        displayName: context.displayName
      }
    },
    listWorktreeTerminals: async (worktreeId) => {
      const result = await delegate.listTerminals(
        `id:${worktreeId}`,
        PLUGIN_WORKSPACE_TERMINAL_LIMIT,
        { includeVisualLayouts: false }
      )
      return result.terminals.slice(0, PLUGIN_WORKSPACE_TERMINAL_LIMIT).map((terminal) => ({
        id: terminal.handle,
        title: pluginTerminalTitle(terminal),
        ...(terminal.tabId && terminal.leafId
          ? { paneKey: `${terminal.tabId}:${terminal.leafId}` }
          : {})
      }))
    },
    listAgentStatuses: () => delegate.listAgentStatuses?.() ?? [],
    sendTerminalText: async (terminalId, action) => {
      const result = await delegate.sendTerminal(terminalId, action, { inputKind: 'driving' })
      return { accepted: result.accepted }
    },
    dispatchPluginNotification: (notification) => delegate.dispatchPluginNotification(notification),
    storage: {
      get: (key, itemKey) => new PluginKvStore(pluginsDataDir, key, 'storage.json').get(itemKey),
      set: (key, itemKey, value) =>
        new PluginKvStore(pluginsDataDir, key, 'storage.json').set(itemKey, value),
      delete: (key, itemKey) =>
        new PluginKvStore(pluginsDataDir, key, 'storage.json').delete(itemKey),
      keys: (key) => new PluginKvStore(pluginsDataDir, key, 'storage.json').keys()
    },
    secrets: {
      get: (key, itemKey) => new PluginSecretsStore(pluginsDataDir, key).get(itemKey),
      set: (key, itemKey, value) => new PluginSecretsStore(pluginsDataDir, key).set(itemKey, value),
      delete: (key, itemKey) => new PluginSecretsStore(pluginsDataDir, key).delete(itemKey),
      protection: () => (pluginSecretsProtection().level === 'os' ? 'os-keyring' : 'unavailable')
    },
    settings: {
      getAll: (key) => ({
        ...pluginSettingDefaults(declared.values()),
        ...new PluginKvStore(pluginsDataDir, key, 'settings.json').getAll()
      }),
      set: (key, itemKey, value) => {
        const setting = declared.get(itemKey)
        const issue = setting ? pluginSettingValueIssue(setting, value) : null
        return issue
          ? { ok: false, error: `${itemKey} ${issue}` }
          : new PluginKvStore(pluginsDataDir, key, 'settings.json').set(itemKey, value)
      }
    }
  }
}
