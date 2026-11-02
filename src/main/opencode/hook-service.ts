import { getAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { isSafeDescendCandidate, mirrorEntry } from '../pty/overlay-mirror'
import {
  getOpenCode2PluginSource,
  getOpenCodeFamilyPluginSource,
  getOpenCodePluginSource
} from './status-plugin-module-source'
import {
  readOpenCodeOverlayManifest,
  clearOpenCodeOverlayManifestEntries,
  writeOpenCodeOverlayManifest,
  type OpenCodeOverlayManifest
} from './opencode-overlay-manifest'
import { resolveOpenCodeConfigDirectory } from '../../shared/opencode-config-directory'
import {
  getOpenCodeLegacySharedConfigDir,
  OPENCODE2_LEGACY_HOOKS_DIR,
  OPENCODE_LEGACY_HOOKS_DIR
} from './legacy-shared-config-dir'
import {
  openCodeTuiPluginDirName,
  writeOpenCodeTuiPlugin
} from '../../shared/opencode-tui-plugin-install'
import { writeLegacyOpenCodePluginWithAclRetry } from './legacy-plugin-acl-retry'
import {
  OPENCODE_OVERLAY_DIR,
  ORCA_OPENCODE_PLUGIN_FILE,
  sourceOverlayDirName,
  toSafeDirName
} from './overlay-dir-names'
import { OpenCodeDirGcLifecycle } from './overlay-dir-gc-lifecycle'

export { getOpenCode2PluginSource, getOpenCodeFamilyPluginSource, getOpenCodePluginSource }

import { writeCanonicalOpenCodePluginAtomically } from '../../shared/opencode-plugin-atomic-write'
import { writeOpenCodePluginConfig } from './opencode-plugin-config-writer'

type OpenCodeHookVariant = {
  pluginFileName: string
  legacyHooksDir: string
  overlayDir: string
  pluginSource: () => string
  /** Install a TUI copy only for OpenCode variants that support it. */
  installsTuiPlugin?: boolean
  tuiOnlyDirectory?: string
}

// IDs are hashed downstream, so separators are valid; cap pathological input.
function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

export class OpenCodeHookService {
  private readonly pluginSource: () => string
  private readonly pluginFileName: string
  private readonly legacyHooksDir: string
  private readonly overlayDir: string
  private readonly installsTuiPlugin: boolean
  private readonly tuiOnlyDirectory: string | undefined
  readonly configDirGc: OpenCodeDirGcLifecycle

  constructor(variant?: OpenCodeHookVariant | (() => string)) {
    const config: OpenCodeHookVariant =
      typeof variant === 'function'
        ? {
            pluginFileName: ORCA_OPENCODE_PLUGIN_FILE,
            legacyHooksDir: OPENCODE_LEGACY_HOOKS_DIR,
            overlayDir: OPENCODE_OVERLAY_DIR,
            pluginSource: variant
          }
        : (variant ?? {
            pluginFileName: ORCA_OPENCODE_PLUGIN_FILE,
            legacyHooksDir: OPENCODE_LEGACY_HOOKS_DIR,
            overlayDir: OPENCODE_OVERLAY_DIR,
            pluginSource: getOpenCodePluginSource,
            installsTuiPlugin: true
          })
    this.pluginSource = config.pluginSource
    this.installsTuiPlugin = config.installsTuiPlugin === true
    this.tuiOnlyDirectory = config.tuiOnlyDirectory
    this.pluginFileName = config.pluginFileName
    this.legacyHooksDir = config.legacyHooksDir
    this.overlayDir = config.overlayDir
    this.configDirGc = new OpenCodeDirGcLifecycle(() => this.getOverlayRoot(), this.pluginFileName)
  }

  clearPty(_ptyId: string): void {
    // Directories outlive individual PTYs; recursive cleanup here can freeze Windows main.
  }

  installIntoSourceOverlay(
    directory: string,
    sourceConfigDir: string,
    owner: OpenCodeHookService
  ): 'unmatched' | 'installed' | 'failed' {
    if (directory !== owner.getSourceOverlayDir(sourceConfigDir)) {
      return 'unmatched'
    }
    try {
      for (const path of [owner.getOverlayRoot(), directory, join(directory, 'plugins')]) {
        if (!isSafeDescendCandidate(lstatSync(path))) {
          return 'failed'
        }
      }
      this.writePluginIntoOverlay(directory)
      owner.configDirGc.reference(directory)
      return 'installed'
    } catch {
      return 'failed'
    }
  }

  buildPtyEnv(
    ptyId: string,
    existingConfigDir?: string | undefined,
    defaultConfigDir?: string
  ): Record<string, string> {
    if (!isUsableId(ptyId)) {
      return existingConfigDir ? { OPENCODE_CONFIG_DIR: existingConfigDir } : {}
    }

    this.refreshLegacySharedPlugin()
    const managedConfigDir = this.getSharedConfigDir()
    if (!existingConfigDir || existingConfigDir === managedConfigDir) {
      try {
        this.writePluginToConfigDir(defaultConfigDir ?? resolveOpenCodeConfigDirectory())
        return {}
      } catch {
        return {}
      }
    }
    if (!existsSync(existingConfigDir) && !this.tuiOnlyDirectory) {
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }
    const overlayDir = this.getSourceOverlayDir(existingConfigDir)
    try {
      // Owned directories must stay real; a replaced parent redirects both cleanup and writes.
      for (const directory of [this.getOverlayRoot(), overlayDir, join(overlayDir, 'plugins')]) {
        mkdirSync(directory, { recursive: true })
        if (!isSafeDescendCandidate(lstatSync(directory))) {
          return { OPENCODE_CONFIG_DIR: existingConfigDir }
        }
      }
      if (existsSync(existingConfigDir)) {
        this.mirrorUserConfig(existingConfigDir, overlayDir)
      }
      this.writePluginIntoOverlay(overlayDir)
      this.configDirGc.reference(overlayDir)
      return { OPENCODE_CONFIG_DIR: overlayDir }
    } catch {
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }
  }

  // Refresh pre-1.4.209 server-only plugins for future loads; running services may retain cached modules.
  refreshLegacySharedPlugin(): void {
    if (this.tuiOnlyDirectory) {
      return
    }
    const pluginsDir = join(this.getSharedConfigDir(), 'plugins')
    const pluginPath = join(pluginsDir, this.pluginFileName)
    try {
      const source = this.pluginSource()
      const installed = readFileSync(pluginPath, 'utf8')
      // Old-directory services must find the TUI copy or they report under the starter pane.
      writeLegacyOpenCodePluginWithAclRetry(
        join(pluginsDir, openCodeTuiPluginDirName(this.pluginFileName), 'tui.js'),
        () => this.writeTuiPlugin(pluginsDir, source)
      )
      if (installed !== source) {
        writeLegacyOpenCodePluginWithAclRetry(pluginPath, () =>
          writeCanonicalOpenCodePluginAtomically(pluginPath, source)
        )
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return
      }
      console.warn('[OpenCode] Failed to repair legacy status plugin:', pluginPath, error)
    }
  }

  // Refresh existing installs at startup so OpenCode 2 reloads upgrades before the next pane opens.
  refreshInstalledPlugins(): void {
    this.refreshLegacySharedPlugin()
    const overlayRoot = this.getOverlayRoot()
    const overlays = existsSync(overlayRoot)
      ? readdirSync(overlayRoot).map((name) => join(overlayRoot, name))
      : []
    const configDir = resolveOpenCodeConfigDirectory()
    for (const dir of [configDir, ...overlays]) {
      if (!existsSync(join(dir, 'plugins', this.pluginFileName))) {
        continue
      }
      try {
        if (dir === configDir) {
          this.writePluginToConfigDir(dir)
        } else {
          this.writePluginIntoOverlay(dir)
        }
      } catch (error) {
        console.warn('[OpenCode] Failed to refresh status plugin:', dir, error)
      }
    }
  }

  private getOverlayRoot(): string {
    return join(getAppEnvironment().getPath('userData'), this.overlayDir)
  }

  private getSourceOverlayDir(sourceConfigDir: string): string {
    return join(this.getOverlayRoot(), sourceOverlayDirName(sourceConfigDir))
  }

  private getSharedConfigDir(): string {
    return getOpenCodeLegacySharedConfigDir(
      getAppEnvironment().getPath('userData'),
      this.legacyHooksDir
    )
  }

  // Link config for live user edits; keep plugins real so Orca can install a sibling.
  private mirrorUserConfig(sourceDir: string, overlayDir: string): void {
    const previousManifest = readOpenCodeOverlayManifest(overlayDir)
    // Remove only mirrored paths; persistent overlays may contain OpenCode runtime directories.
    clearOpenCodeOverlayManifestEntries(overlayDir, previousManifest, this.pluginFileName)

    const nextManifest: OpenCodeOverlayManifest = {
      topLevelEntries: [],
      pluginEntries: [],
      sourceConfigDir: sourceDir
    }

    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = join(sourceDir, entry.name)

      if (entry.name === 'plugins') {
        // Windows junctions report both flags; symlink handling must win.
        const isSymlink = entry.isSymbolicLink()
        let isLinkPointingToDir = false
        if (isSymlink) {
          try {
            isLinkPointingToDir = statSync(sourcePath).isDirectory()
          } catch {
            // Preserve broken/inaccessible symlinks verbatim.
            isLinkPointingToDir = false
          }
        }

        if ((!isSymlink && entry.isDirectory()) || isLinkPointingToDir) {
          // Resolve user plugin links while keeping the overlay directory real to contain writes.
          const resolvedSource = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
          const overlayPluginsDir = join(overlayDir, 'plugins')
          mkdirSync(overlayPluginsDir, { recursive: true })
          for (const pluginEntry of readdirSync(resolvedSource, { withFileTypes: true })) {
            // Never mirror Orca’s filename: installation would overwrite the user’s target.
            if (
              pluginEntry.name === this.pluginFileName ||
              pluginEntry.name === this.tuiOnlyDirectory ||
              (this.installsTuiPlugin &&
                pluginEntry.name === openCodeTuiPluginDirName(this.pluginFileName))
            ) {
              continue
            }
            mirrorEntry(
              join(resolvedSource, pluginEntry.name),
              join(overlayPluginsDir, pluginEntry.name)
            )
            nextManifest.pluginEntries.push(pluginEntry.name)
          }
          continue
        }
      }

      mirrorEntry(sourcePath, join(overlayDir, entry.name))
      nextManifest.topLevelEntries.push(entry.name)
    }

    writeOpenCodeOverlayManifest(overlayDir, nextManifest)
  }

  private writePluginIntoOverlay(overlayDir: string): void {
    this.writePluginToDirectory(overlayDir, 'overlay')
  }

  private writePluginToConfigDir(configDir: string): void {
    this.writePluginToDirectory(configDir, 'canonical')
  }

  private writePluginToDirectory(configDir: string, ownership: 'canonical' | 'overlay'): void {
    writeOpenCodePluginConfig({
      configDir,
      ownership,
      pluginFileName: this.pluginFileName,
      getSource: () => this.pluginSource(),
      installsTuiPlugin: this.installsTuiPlugin,
      tuiOnlyDirectory: this.tuiOnlyDirectory
    })
  }

  private writeTuiPlugin(
    pluginsDir: string,
    source: string,
    ownership: 'canonical' | 'overlay' = 'canonical'
  ): void {
    if (this.installsTuiPlugin) {
      writeOpenCodeTuiPlugin(pluginsDir, this.pluginFileName, source, ownership)
    }
  }
}

export const openCodeHookService = new OpenCodeHookService()
export const openCode2HookService = new OpenCodeHookService({
  pluginFileName: 'orca-opencode2-status.js',
  legacyHooksDir: OPENCODE2_LEGACY_HOOKS_DIR,
  overlayDir: 'opencode2-config-overlays',
  pluginSource: getOpenCode2PluginSource,
  installsTuiPlugin: true
})
export const _internals = {
  getOpenCodePluginSource,
  getOpenCode2PluginSource,
  isUsableId,
  toSafeDirName
}
