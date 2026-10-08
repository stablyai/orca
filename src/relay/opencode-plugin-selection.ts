import {
  getOpenCodeCliCapabilities,
  type OpenCodeCliCapabilities
} from '../shared/opencode-cli-version'
import { addWslEnvKeys } from '../shared/wsl-env'

export function restoreOpenCodeCapabilities(value: unknown): OpenCodeCliCapabilities | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    typeof value.version !== 'string'
  ) {
    return undefined
  }
  const capabilities = getOpenCodeCliCapabilities(value.version)
  return capabilities.pluginApi === 'unknown' ? undefined : capabilities
}

export function applyOpenCodePluginSelection(
  env: Record<string, string>,
  envToDelete: string[],
  capabilities: OpenCodeCliCapabilities | null | undefined,
  wsl: boolean
): void {
  delete env.ORCA_OPENCODE_PLUGIN_API
  if (!capabilities || capabilities.pluginApi === 'unknown') {
    return
  }
  env.ORCA_OPENCODE_PLUGIN_API = capabilities.pluginApi
  for (let index = envToDelete.length - 1; index >= 0; index -= 1) {
    if (envToDelete[index] === 'ORCA_OPENCODE_PLUGIN_API') {
      envToDelete.splice(index, 1)
    }
  }
  if (wsl) {
    addWslEnvKeys(env, ['ORCA_OPENCODE_PLUGIN_API'])
  }
}
