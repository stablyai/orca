import { getAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'
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
      } catch {
        // The managed directory may still be writable.
      }
      try {
        // Why: older installs and inherited env still load plugins from
        // userData/opencode-hooks/shared via OPENCODE_CONFIG_DIR; refresh that
        // copy too so a plain `opencode` does not keep a pre-setup() template (#22764).
        this.writePluginToConfigDir(managedConfigDir)
      } catch {
        // Both writes are best effort.
      }
      return {}
    }
    if (!existsSync(existingConfigDir)) {
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }
    const overlayDir = this.getSourceOverlayDir(existingConfigDir)
    try {
      mkdirSync(overlayDir, { recursive: true })
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
            if (pluginEntry.name === this.pluginFileName) {
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

  // Why: pre-write unlink guards against POSIX writeFileSync writing through a mirrored symlink and clobbering a same-named user plugin.
  private writePluginIntoOverlay(overlayDir: string): void {
    const pluginsDir = join(overlayDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const pluginPath = join(pluginsDir, this.pluginFileName)
    try {
      unlinkSync(pluginPath)
    } catch {
      // File may not exist on a fresh overlay; a real failure surfaces on writeFileSync below.
    }
    writeFileSync(pluginPath, this.pluginSource())
  }

  private writePluginToConfigDir(configDir: string): void {
    const pluginsDir = join(configDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(join(pluginsDir, this.pluginFileName), this.pluginSource())
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
