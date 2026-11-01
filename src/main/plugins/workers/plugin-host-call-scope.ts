import type { PluginErrorCode } from '../../../shared/plugins/frames/plugin-protocol'
import type { PluginPanelCaller } from '../../../shared/plugins/workers/plugin-panel-bridge-protocol'

/**
 * What one admitted call carries to its side effect. `assertActive` throws once the plugin was
 * disabled, unconsented, kill-listed or removed since admission, so a call that waited (an audit
 * write, a save dialog) never commits for a plugin that lost its approval meanwhile.
 */
export type PluginHostCallScope = {
  assertActive(): void
  /** The WebContents whose frame made the call (desktop IPC only): dialogs and budgets bind to it. */
  callerWebContentsId?: number
  /** The plugin's display name, for prompts Orca shows on its behalf. */
  pluginName?: string
  /** The open panel or editor that made the call; absent for workers. */
  panel?: PluginPanelCaller
  /** Writes to the plugin's log (`orca plugin logs`). */
  log?: (line: string) => void
}

export const UNSCOPED_PLUGIN_HOST_CALL: PluginHostCallScope = { assertActive: () => {} }

/** A service failure whose code reaches the plugin instead of collapsing to `action_failed`. */
export class PluginHostCallError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
  }
}

export function pluginHostCallRevoked(): PluginHostCallError {
  return new PluginHostCallError('consent_required', 'plugin is no longer enabled')
}
