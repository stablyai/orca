import { readHooksJson, writeHooksJson } from '../agent-hooks/installer-utils'
import {
  getManagedScriptFileName,
  getStatusLineScriptFileName,
  removeManagedHooks,
  removeManagedStatusLine,
  type ClaudeCompatibleHookSettings
} from './hook-settings'

/** Each root is independent: a broken settings file must not prevent cleanup of the other. */
export function removeClaudeHookSettings(
  settings: ClaudeCompatibleHookSettings,
  configPath: string
): string | null {
  try {
    const config = readHooksJson(configPath)
    if (!config) {
      return `Could not parse settings.json at ${configPath}`
    }
    const hooks = removeManagedHooks(config, getManagedScriptFileName(settings))
    const statusLine = removeManagedStatusLine(hooks.config, getStatusLineScriptFileName(settings))
    if (hooks.changed || statusLine.changed) {
      writeHooksJson(configPath, statusLine.config)
    }
    return null
  } catch (error) {
    return `${configPath}: ${error instanceof Error ? error.message : String(error)}`
  }
}
