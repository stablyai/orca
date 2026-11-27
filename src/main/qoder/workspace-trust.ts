import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  isPlainObject,
  readHooksJson
} from '../agent-hooks/installation/configuration/hooks-json-read'
import { writeHooksJson } from '../agent-hooks/installation/configuration/hooks-json-write'

// permissions.trustDirectories shape shared by Qoder 1.1.64 (written on folder-trust accept) and Qwen Code 1.0.
export function withTrustDirectory(
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
    // Missing paths retain their supplied spelling.
  }
  const configPath = join(home, configDirName, 'settings.json')
  const config = readHooksJson(configPath)
  if (!config) {
    return
  }
  const updated = withTrustDirectory(config, canonicalPath)
  if (updated && updated !== config) {
    writeHooksJson(configPath, updated)
  }
}
