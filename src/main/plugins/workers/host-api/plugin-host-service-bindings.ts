import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../../../shared/plugins/workers/plugin-host-api'
import type { PluginHostServices, PluginDesktopFrameServices } from './plugin-host-method-bindings'
import type { PluginPanelBridgeServices } from './plugin-host-panel-method-bindings'
import type { PluginStatusBarState } from '../../status-bar/plugin-status-bar-state'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'
import type { PluginHostRendererActions } from '../../view/plugin-host-renderer-actions'
import {
  pluginSettingValueIssue,
  type PluginSettingContribution
} from '../../../../shared/plugins/contributions/plugin-settings-contribution'
import { pluginSettingDefaults } from '../../../../shared/plugins/contributions/plugin-settings-values'
import { PluginSecretsStore, pluginSecretsProtection } from '../../plugin-secrets-store'
import { PluginKvStore } from '../../plugin-storage-store'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import { pluginTerminalTitle, type PluginAgentStatusRow } from './plugin-workspace-projection'
import type { PluginAppearanceService } from '../../appearance/plugin-appearance-service'
import type { PluginEditorTypographySource } from '../../appearance/plugin-editor-typography'

export type PluginRuntimeDelegate = {
  resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    identityKey?: string
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
  /** Dispatched orchestration task titles by pane key; absent where no runtime dispatches tasks. */
  listAgentTaskTitles?(): ReadonlyMap<string, string>
  /** The runtime RPC the `orca` CLI calls, in process; absent where none is bound. */
  callRuntime?: PluginRuntimeRpc
}

export function bindPluginHostServices(input: {
  delegate: PluginRuntimeDelegate
  pluginsDataDir: string
  desktop?: PluginDesktopFrameServices | null
  panels?: PluginPanelBridgeServices | null
  renderer?: PluginHostRendererActions | null
  hasSettingsPage?: boolean
  /** The calling plugin's `contributes.settings`: defaults and value checks. */
  declaredSettings?: readonly PluginSettingContribution[]
  statusBar?: PluginStatusBarState | null
  appearance?: PluginAppearanceService | null
  editorTypography?: PluginEditorTypographySource | null
  /** Ids of the calling plugin's `contributes.statusBarItems`, and its install's revision. */
  declaredStatusBarItemIds?: readonly string[]
  statusBarRevision?: string
}): PluginHostServices {
  const declared = new Map((input.declaredSettings ?? []).map((setting) => [setting.key, setting]))
  const { delegate, pluginsDataDir } = input
  return {
    hasSettingsPage: input.hasSettingsPage === true,
    appearance: input.appearance ?? null,
    editorTypography: input.editorTypography ?? null,
    desktop: input.desktop ?? null,
    confirm: input.desktop?.confirm ?? null,
    panels: input.panels ?? null,
    statusBar: input.statusBar
      ? statusBarServices(input.statusBar, input.declaredStatusBarItemIds, input.statusBarRevision)
      : null,
    runtimeRpc: delegate.callRuntime ?? null,
    renderer: input.renderer ?? null,
    resolveActiveWorktreeContext: async () => {
      const context = await delegate.resolveActiveWorktreeContext()
      if (!context) {
        return null
      }
      // Retain path-bearing worktree IDs for host membership checks; public projections expose
      // the identity form instead when there is one.
      return {
        worktreeId: context.worktreeId,
        ...(context.identityKey ? { identityKey: context.identityKey } : {}),
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
    listAgentTaskTitles: () => {
      try {
        return delegate.listAgentTaskTitles?.() ?? new Map()
      } catch {
        // Task titles are optional; an orchestration read failure must not lose the agent rows.
        return new Map()
      }
    },
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

function statusBarServices(
  state: PluginStatusBarState,
  declaredIds: readonly string[] = [],
  revision = ''
): NonNullable<PluginHostServices['statusBar']> {
  const declared = new Set(declaredIds)
  return {
    update: (pluginKey, itemId, patch) => {
      if (!declared.has(itemId)) {
        return false
      }
      state.update(pluginKey, revision, itemId, patch)
      return true
    }
  }
}
