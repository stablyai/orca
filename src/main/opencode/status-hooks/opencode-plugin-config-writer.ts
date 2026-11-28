import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isInstalledOpenCodePluginCurrent,
  isOverlayOpenCodePluginCurrent
} from '../../../shared/agent-launch/plugins/opencode/opencode-installed-plugin'
import {
  writeCanonicalOpenCodePluginAtomically,
  writeOverlayOpenCodePluginAtomically
} from '../../../shared/agent-launch/plugins/opencode/opencode-plugin-atomic-write'
import {
  writeOpenCodeTuiPlugin,
  writeOpenCodeTuiPluginDirectory
} from '../../../shared/agent-launch/plugins/opencode/opencode-tui-plugin-install'

let cachedSourceBytes: { source: string; bytes: Buffer } | null = null

function encodePluginSource(source: string): Buffer {
  if (cachedSourceBytes?.source === source) {
    return cachedSourceBytes.bytes
  }
  const bytes = Buffer.from(source, 'utf8')
  cachedSourceBytes = { source, bytes }
  return bytes
}

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
  const sourceBytes = encodePluginSource(source)
  const current = overlay
    ? isOverlayOpenCodePluginCurrent(pluginPath, sourceBytes)
    : isInstalledOpenCodePluginCurrent(pluginPath, sourceBytes)
  if (!current) {
    const write = overlay
      ? writeOverlayOpenCodePluginAtomically
      : writeCanonicalOpenCodePluginAtomically
    write(pluginPath, source)
  }
}
