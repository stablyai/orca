import type { PluginJsonValue } from '../../../../shared/plugins/workers/plugin-host-api'
import type { PluginAppearanceService } from '../../appearance/plugin-appearance-service'
import type { PluginEditorTypographySource } from '../../appearance/plugin-editor-typography'
import type {
  PluginActionConfirmation,
  PluginConfirmationSubject
} from '../../consent/plugin-confirmation-subject'
import type { PluginHostRendererActions } from '../../view/plugin-host-renderer-actions'
import type { PluginHostCallScope } from './plugin-host-call-scope'
import type {
  PluginAgentStatusRow,
  PluginWorkspaceTerminal
} from './plugin-workspace-projection'
import type { PluginPanelBridgeServices } from './plugin-host-panel-method-bindings'
import type { PluginStatusBarServices } from './plugin-host-status-bar-method-bindings'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'

export type PluginWorktreeContext = {
  worktreeId: string
  /** Host-qualified identity key, which `workspace.list` ids carry; absent without one. */
  identityKey?: string
  branch: string
  displayName: string
}

/** Desktop-only sinks for frame methods and host confirmations; absent in headless serve. */
export type PluginDesktopFrameServices = {
  /** Asks the person in the calling frame's window, else Orca's focused or first window. */
  confirm(
    pluginId: string,
    subject: PluginConfirmationSubject,
    scope: PluginHostCallScope
  ): Promise<PluginActionConfirmation>
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
  hasSettingsPage?: boolean
  appearance?: PluginAppearanceService | null
  /** This Orca's own editor settings; absent where no profile is loaded (relay conformance). */
  editorTypography?: PluginEditorTypographySource | null
  resolveActiveWorktreeContext(): Promise<PluginWorktreeContext | null>
  listWorktreeTerminals(worktreeId: string): Promise<PluginWorkspaceTerminal[]>
  listAgentStatuses(): readonly PluginAgentStatusRow[]
  /** The title of the orchestration task each pane runs, by pane key (`tabId:leafId`); absent
   *  where no runtime dispatches tasks. */
  listAgentTaskTitles?(): ReadonlyMap<string, string>
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
  /** Absent where no Orca window draws a status bar. */
  statusBar?: PluginStatusBarServices | null
  /** The runtime methods the `orca` CLI calls, for workspace actions; absent without a runtime. */
  runtimeRpc?: PluginRuntimeRpc | null
  /** Orca's window, for actions only it can take; absent in headless serve. */
  renderer?: PluginHostRendererActions | null
  /** Asks the person before the plugin acts; absent where nobody can be asked (headless serve).
   *  Re-checks the plugin's approval once the person answers. */
  confirm?: PluginDesktopFrameServices['confirm'] | null
  settings: {
    getAll(pluginId: string): Record<string, PluginJsonValue>
    set(
      pluginId: string,
      key: string,
      value: PluginJsonValue
    ): { ok: true } | { ok: false; error: string }
  }
}
