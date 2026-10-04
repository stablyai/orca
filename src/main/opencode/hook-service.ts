import { getAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { isSafeDescendCandidate, mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'
import {
  getOpenCode2PluginSource,
  getOpenCodeFamilyPluginSource,
  getOpenCodePluginSource
} from './status-plugin-module-source'
import {
  readOpenCodeOverlayManifest,
  OPENCODE_OVERLAY_MANIFEST_FILE,
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

export { getOpenCode2PluginSource, getOpenCodeFamilyPluginSource, getOpenCodePluginSource }

import { writeCanonicalOpenCodePluginAtomically } from '../../shared/opencode-plugin-atomic-write'
import { writeOpenCodePluginConfig } from './opencode-plugin-config-writer'

const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
const OPENCODE_OVERLAY_DIR = 'opencode-config-overlays'

type OpenCodeHookVariant = {
  pluginFileName: string
  legacyHooksDir: string
  overlayDir: string
  pluginSource: () => string
  /** Also install the module as an OpenCode 2 TUI plugin (never for forks without one). */
  installsTuiPlugin?: boolean
  tuiOnlyDirectory?: string
}

// Why: session IDs may contain path separators and are hashed downstream; cap pathological input.
function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

function toSafeDirName(id: string): string {
  // Why: 32 hex chars (128 bits) makes collisions negligible and stays filesystem-portable (no base64 padding or `/`).
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

// Why: installs the plugin into OpenCode's config discovery path so it POSTs to the shared agent-hooks server, unifying OpenCode status with Claude/Codex/Gemini.
export class OpenCodeHookService {
  private readonly pluginSource: () => string
  private readonly pluginFileName: string
  private readonly legacyHooksDir: string
  private readonly overlayDir: string
  private readonly installsTuiPlugin: boolean
  private readonly tuiOnlyDirectory: string | undefined

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
  }

  clearPty(_ptyId: string): void {
    // Why: no-op — config dirs are app/source-scoped now, and recursive delete on the main-process hot path could freeze on Windows.
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
      return 'installed'
    } catch {
      return 'failed'
    }
  }

  buildPtyEnv(ptyId: string, existingConfigDir?: string | undefined): Record<string, string> {
    if (!isUsableId(ptyId)) {
      // Why: on a bad id, still preserve a user-set OPENCODE_CONFIG_DIR; only the Orca status plugin is forfeited.
      return existingConfigDir ? { OPENCODE_CONFIG_DIR: existingConfigDir } : {}
    }

    this.refreshLegacySharedPlugin()
    const managedConfigDir = this.getSharedConfigDir()
    if (!existingConfigDir || existingConfigDir === managedConfigDir) {
      try {
        this.writePluginToConfigDir(resolveOpenCodeConfigDirectory())
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
      mkdirSync(overlayDir, { recursive: true })
      if (existsSync(existingConfigDir)) {
        this.mirrorUserConfig(existingConfigDir, overlayDir)
      }
      this.writePluginIntoOverlay(overlayDir)
      return { OPENCODE_CONFIG_DIR: overlayDir }
    } catch {
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }
  }

  // Why: pre-1.4.209 Orca left a server()-only plugin here that OpenCode 2 rejects. Only helps
  // processes that load it later; a running OpenCode 2 service keeps its cached module until restarted.
  refreshLegacySharedPlugin(): void {
    if (this.tuiOnlyDirectory) {
      return
    }
    const pluginsDir = join(this.getSharedConfigDir(), 'plugins')
    const pluginPath = join(pluginsDir, this.pluginFileName)
    try {
      const source = this.pluginSource()
      const installed = readFileSync(pluginPath, 'utf8')
      // Why: a TUI or service still loading this dir needs the TUI copy too, or the service keeps reporting under its starter pane.
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

  // Why: a running OpenCode 2 service reloads a changed plugin file, so refreshing Orca's existing
  // installs at app start upgrades it without waiting for the next pane. Never creates an install.
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
    return join(this.getOverlayRoot(), toSafeDirName(`source:${sourceConfigDir}`))
  }

  private getSharedConfigDir(): string {
    return getOpenCodeLegacySharedConfigDir(
      getAppEnvironment().getPath('userData'),
      this.legacyHooksDir
    )
  }

  private writeOverlayManifest(overlayDir: string, manifest: OpenCodeOverlayManifest): void {
    writeFileSync(
      join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
  }

  private clearManifestEntries(overlayDir: string, manifest: OpenCodeOverlayManifest): void {
    for (const entryName of manifest.topLevelEntries) {
      safeRemoveTree(join(overlayDir, entryName))
    }

    const overlayPluginsDir = join(overlayDir, 'plugins')
    for (const entryName of manifest.pluginEntries) {
      if (entryName === this.pluginFileName) {
        continue
      }
      safeRemoveTree(join(overlayPluginsDir, entryName))
    }
  }

  // Why: mirror user config entries as symlinks so edits propagate live; only plugins/ becomes a real overlay dir so Orca can drop a sibling plugin file.
  private mirrorUserConfig(sourceDir: string, overlayDir: string): void {
    const previousManifest = readOpenCodeOverlayManifest(overlayDir)
    // Why: overlays persist across terminals; remove only Orca-mirrored paths so stale user config clears but OpenCode runtime dirs (node_modules) survive.
    this.clearManifestEntries(overlayDir, previousManifest)

    const nextManifest: OpenCodeOverlayManifest = { topLevelEntries: [], pluginEntries: [] }

    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = join(sourceDir, entry.name)

      if (entry.name === 'plugins') {
        // Why: check isSymbolicLink before isDirectory — a Windows junction reports both, and the symlink branch must win.
        const isSymlink = entry.isSymbolicLink()
        let isLinkPointingToDir = false
        if (isSymlink) {
          try {
            isLinkPointingToDir = statSync(sourcePath).isDirectory()
          } catch {
            // Why: broken/inaccessible symlink — mirror the dangling link verbatim instead of resolving through it.
            isLinkPointingToDir = false
          }
        }

        if ((!isSymlink && entry.isDirectory()) || isLinkPointingToDir) {
          // Why: resolve a symlinked plugins/ to its real target so <overlay>/plugins stays a real dir and writePluginIntoOverlay can't write through the user's link.
          const resolvedSource = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
          const overlayPluginsDir = join(overlayDir, 'plugins')
          mkdirSync(overlayPluginsDir, { recursive: true })
          for (const pluginEntry of readdirSync(resolvedSource, { withFileTypes: true })) {
            // Why: skip a user plugin sharing Orca's filename; mirroring it would let writePluginIntoOverlay clobber the user's file.
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

    this.writeOverlayManifest(overlayDir, nextManifest)
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
