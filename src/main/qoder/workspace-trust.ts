import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isPlainObject, readHooksJson, writeHooksJson } from '../agent-hooks/installer-utils'

// Qoder 1.1.64 writes this exact shape after accepting its folder-trust prompt.
export function withQoderTrustedWorkspace(
  config: Record<string, unknown>,
  workspacePath: string
): Record<string, unknown> | null {
  if (config.permissions !== undefined && !isPlainObject(config.permissions)) {
    return null
  }
  const permissions = isPlainObject(config.permissions) ? config.permissions : {}
  if (permissions.trustDirectories !== undefined && !Array.isArray(permissions.trustDirectories)) {
    return null
  }
  const existing = Array.isArray(permissions.trustDirectories) ? permissions.trustDirectories : []
  if (existing.includes(workspacePath)) {
    return config
  }
  return {
    ...config,
    permissions: { ...permissions, trustDirectories: [...existing, workspacePath] }
  }
}

export function markQoderWorkspaceTrusted(
  workspacePath: string,
  home: string,
  configDirName: '.qoder' | '.qoder-cn' = '.qoder'
): void {
  let canonicalPath = workspacePath
  try {
    canonicalPath = realpathSync.native(workspacePath)
  } catch {
    /* Keep the supplied path when absent. */
  }
  const configPath = join(home, configDirName, 'settings.json')
  const config = readHooksJson(configPath)
  if (!config) {
    return
  }
  const updated = withQoderTrustedWorkspace(config, canonicalPath)
  if (updated && updated !== config) {
    writeHooksJson(configPath, updated)
  }
}
