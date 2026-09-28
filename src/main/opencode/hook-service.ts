import { getAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { writeManagedConfigFile } from '../pty/managed-config-file'
import {
  ensureOverlayDirectory,
  mirrorEntry,
  mirrorPluginDirectory,
  safeRemoveTree
} from '../pty/overlay-mirror'
import { getStatusPluginEndpointSource } from './status-plugin-endpoint-source'
import { getStatusPluginRuntimeStateSource } from './status-plugin-runtime-state-source'
import { getStatusPluginMessagePreviewSource } from './status-plugin-message-preview-source'
import { getStatusPluginSessionLineageSource } from './status-plugin-session-lineage-source'
import { getStatusPluginPostSource } from './status-plugin-post-source'
import { getStatusPluginDeliverySource } from './status-plugin-delivery-source'
import { getStatusPluginOwnershipSource } from './status-plugin-ownership-source'
import { getStatusPluginLifecycleSource } from './status-plugin-lifecycle-source'
import { getStatusPluginFactorySource } from './status-plugin-factory-source'
import { resolveOpenCodeConfigDirectory } from '../../shared/opencode-config-directory'

const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
const OPENCODE_LEGACY_HOOKS_DIR = 'opencode-hooks'
const OPENCODE_OVERLAY_DIR = 'opencode-config-overlays'
const OPENCODE_SHARED_CONFIG_DIR = 'shared'
const OPENCODE_OVERLAY_MANIFEST_FILE = '.orca-opencode-overlay-manifest.json'

type OpenCodeOverlayManifest = {
  topLevelEntries: string[]
  pluginEntries: string[]
}

type OpenCodeHookVariant = {
  pluginFileName: string
  legacyHooksDir: string
  overlayDir: string
  pluginSource: () => string
}

// Why: session IDs may contain path separators and are hashed downstream; cap pathological input.
function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

function toSafeDirName(id: string): string {
  // Why: 32 hex chars (128 bits) makes collisions negligible and stays filesystem-portable (no base64 padding or `/`).
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

// Both major versions install as `opencode`; let the loader choose server() or setup().
export function getOpenCodePluginSource(): string {
  return getOpenCodeFamilyPluginSource('/hook/opencode', {
    emitSessionStart: true,
    emitNextEvents: true,
    expectedAgent: 'opencode'
  })
}

export function getOpenCode2PluginSource(): string {
  return getOpenCodeFamilyPluginSource('/hook/opencode2', {
    emitSessionStart: true,
    emitNextEvents: true
  })
}

export function getOpenCodeFamilyPluginSource(
  hookPathname: string,
  options: {
    emitSessionStart: boolean
    emitNextEvents?: boolean
    expectedAgent?: 'opencode' | 'opencode2'
  }
): string {
  // Why: the plugin posts PTY environment data from OpenCode to the shared hooks server.
  return [
    ...getStatusPluginEndpointSource(),
    ...getStatusPluginRuntimeStateSource(),
    ...getStatusPluginMessagePreviewSource(),
    ...getStatusPluginSessionLineageSource(),
    ...getStatusPluginPostSource(hookPathname),
    ...getStatusPluginDeliverySource(),
    ...getStatusPluginOwnershipSource(),
    ...getStatusPluginLifecycleSource(),
    ...getStatusPluginFactorySource(options)
  ].join('\n')
}

// Why: installs the plugin into OpenCode's config discovery path so it POSTs to the shared agent-hooks server, unifying OpenCode status with Claude/Codex/Gemini.
export class OpenCodeHookService {
  private readonly pluginSource: () => string
  private readonly pluginFileName: string
  private readonly legacyHooksDir: string
  private readonly overlayDir: string

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
            pluginSource: getOpenCodePluginSource
          })
    this.pluginSource = config.pluginSource
    this.pluginFileName = config.pluginFileName
    this.legacyHooksDir = config.legacyHooksDir
    this.overlayDir = config.overlayDir
  }

  clearPty(_ptyId: string): void {
    // Why: no-op — config dirs are app/source-scoped now, and recursive delete on the main-process hot path could freeze on Windows.
  }

  buildPtyEnv(ptyId: string, existingConfigDir?: string | undefined): Record<string, string> {
    if (!isUsableId(ptyId)) {
      // Why: on a bad id, still preserve a user-set OPENCODE_CONFIG_DIR; only the Orca status plugin is forfeited.
      return existingConfigDir ? { OPENCODE_CONFIG_DIR: existingConfigDir } : {}
    }

    const managedConfigDir = this.getSharedConfigDir()
    if (!existingConfigDir || existingConfigDir === managedConfigDir) {
      try {
        this.writePluginToConfigDir(resolveOpenCodeConfigDirectory())
        return {}
      } catch {
        return {}
      }
    }
    if (!existsSync(existingConfigDir)) {
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }
    const overlayDir = this.getSourceOverlayDir(existingConfigDir)
    try {
      ensureOverlayDirectory(overlayDir)
      this.mirrorUserConfig(existingConfigDir, overlayDir)
      this.writePluginIntoOverlay(overlayDir)
      return { OPENCODE_CONFIG_DIR: overlayDir }
    } catch {
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }
  }

  private getOverlayRoot(): string {
    return join(getAppEnvironment().getPath('userData'), this.overlayDir)
  }

  private getSourceOverlayDir(sourceConfigDir: string): string {
    return join(this.getOverlayRoot(), toSafeDirName(`source:${sourceConfigDir}`))
  }

  private getSharedConfigDir(): string {
    return join(
      getAppEnvironment().getPath('userData'),
      this.legacyHooksDir,
      OPENCODE_SHARED_CONFIG_DIR
    )
  }

  private readOverlayManifest(overlayDir: string): OpenCodeOverlayManifest {
    try {
      const parsed = JSON.parse(
        readFileSync(join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE), 'utf8')
      ) as Partial<OpenCodeOverlayManifest>
      return {
        topLevelEntries: Array.isArray(parsed.topLevelEntries) ? parsed.topLevelEntries : [],
        pluginEntries: Array.isArray(parsed.pluginEntries) ? parsed.pluginEntries : []
      }
    } catch {
      return { topLevelEntries: [], pluginEntries: [] }
    }
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
    const previousManifest = this.readOverlayManifest(overlayDir)
    // Why: overlays persist across terminals; remove only Orca-mirrored paths so stale user config clears but OpenCode runtime dirs (node_modules) survive.
    this.clearManifestEntries(overlayDir, previousManifest)

    const nextManifest: OpenCodeOverlayManifest = { topLevelEntries: [], pluginEntries: [] }

    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = join(sourceDir, entry.name)

      if (entry.name === 'plugins') {
        const pluginEntries = mirrorPluginDirectory(
          sourcePath,
          join(overlayDir, 'plugins'),
          entry,
          this.pluginFileName
        )
        if (pluginEntries !== null) {
          nextManifest.pluginEntries = pluginEntries
          continue
        }
      }

      mirrorEntry(sourcePath, join(overlayDir, entry.name))
      nextManifest.topLevelEntries.push(entry.name)
    }

    this.writeOverlayManifest(overlayDir, nextManifest)
  }

  // Why: overlays persist across terminals and the manifest that tracks them can
  // be lost, so <overlay>/plugins can still be a link into the user's real plugins
  // dir on the next launch. Demanding a real directory is what keeps the write off
  // the user's files; a swallowed unlink error used to let the write proceed
  // through whatever was actually there. Deliberately not an exclusive create:
  // panes sharing one source config share this overlay, and an EEXIST there would
  // silently cost a concurrent pane its status plugin for no safety gain on a
  // proven-real directory holding an Orca-owned filename.
  private writePluginIntoOverlay(overlayDir: string): void {
    const pluginsDir = join(overlayDir, 'plugins')
    ensureOverlayDirectory(pluginsDir)
    writeManagedConfigFile(join(pluginsDir, this.pluginFileName), this.pluginSource())
  }

  // Why: this mode installs into the user's own config dir, so that directory is
  // legitimately theirs and gets no real-directory guard; only the
  // replace-not-write-through step applies.
  private writePluginToConfigDir(configDir: string): void {
    const pluginsDir = join(configDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeManagedConfigFile(join(pluginsDir, this.pluginFileName), this.pluginSource())
  }
}

export const openCodeHookService = new OpenCodeHookService()
export const openCode2HookService = new OpenCodeHookService({
  pluginFileName: 'orca-opencode2-status.js',
  legacyHooksDir: 'opencode2-hooks',
  overlayDir: 'opencode2-config-overlays',
  pluginSource: getOpenCode2PluginSource
})
export const _internals = {
  getOpenCodePluginSource,
  getOpenCode2PluginSource,
  isUsableId,
  toSafeDirName
}
