import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isInstalledOpenCodePluginCurrent,
  isOverlayOpenCodePluginCurrent
} from '../../shared/opencode-installed-plugin'
import {
  writeCanonicalOpenCodePluginAtomically,
  writeOverlayOpenCodePluginAtomically
} from '../../shared/opencode-plugin-atomic-write'
import {
  writeOpenCodeTuiPlugin,
  writeOpenCodeTuiPluginDirectory
} from '../../shared/opencode-tui-plugin-install'

export function writeOpenCodePluginConfig(options: {
  configDir: string
  pluginFileName: string
  getSource: () => string
  installsTuiPlugin: boolean
  tuiOnlyDirectory: string | undefined
  ownership: 'canonical' | 'overlay'
}): void {
  const pluginsDir = join(options.configDir, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })
  const pluginPath = join(pluginsDir, options.pluginFileName)
  const source = options.getSource()
  if (options.tuiOnlyDirectory) {
    writeOpenCodeTuiPluginDirectory(pluginsDir, options.tuiOnlyDirectory, source, options.ownership)
    return
  }
  if (options.installsTuiPlugin) {
    writeOpenCodeTuiPlugin(pluginsDir, options.pluginFileName, source, options.ownership)
  }
  const overlay = options.ownership === 'overlay'
  const current = overlay
    ? isOverlayOpenCodePluginCurrent(pluginPath, source)
    : isInstalledOpenCodePluginCurrent(pluginPath, source)
  if (!current) {
    const write = overlay
      ? writeOverlayOpenCodePluginAtomically
      : writeCanonicalOpenCodePluginAtomically
    write(pluginPath, source)
  }
}
