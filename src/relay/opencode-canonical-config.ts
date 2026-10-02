import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { resolveOpenCodeConfigDirectory } from '../shared/opencode-config-directory'
import { isInstalledOpenCodePluginCurrent } from '../shared/opencode-installed-plugin'
import { writeOpenCodeTuiPlugin } from '../shared/opencode-tui-plugin-install'

const RELAY_HOOKS_DIR = '.orca-relay'

export type OpenCodeAgent = 'opencode' | 'opencode2'

export function installOpenCodePluginInCanonicalConfig(
  source: string,
  agent: OpenCodeAgent,
  environment: NodeJS.ProcessEnv | Record<string, string>,
  homeDir: string,
  onlyIfInstalled = false
): boolean {
  try {
    const configDir = resolveOpenCodeConfigDirectory(environment, homeDir)
    const pluginFileName =
      agent === 'opencode2' ? 'orca-opencode2-status.js' : 'orca-opencode-status.js'
    const pluginPath = join(configDir, 'plugins', pluginFileName)
    if (onlyIfInstalled && !existsSync(pluginPath)) {
      return false
    }
    mkdirSync(join(configDir, 'plugins'), { recursive: true })
    writeOpenCodeTuiPlugin(join(configDir, 'plugins'), pluginFileName, source)
    if (!isInstalledOpenCodePluginCurrent(pluginPath, source)) {
      try {
        unlinkSync(pluginPath)
      } catch {
        // The file may not exist on the first install.
      }
      writeFileSync(pluginPath, source)
    }
    return true
  } catch (err) {
    process.stderr.write(
      `[plugin-overlay] failed to install ${agent} plugin: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return false
  }
}

export function isRelayOpenCodeOverlayPath(path: string, homeDir: string): boolean {
  const relayRoot = resolve(homeDir, RELAY_HOOKS_DIR)
  const candidate = resolve(isAbsolute(path) ? path : join(homeDir, path))
  const relativePath = relative(relayRoot, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}
