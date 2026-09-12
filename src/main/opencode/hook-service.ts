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

const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
const OPENCODE_LEGACY_HOOKS_DIR = 'opencode-hooks'
const OPENCODE_OVERLAY_DIR = 'opencode-config-overlays'
const OPENCODE_SHARED_CONFIG_DIR = 'shared'
const OPENCODE_OVERLAY_MANIFEST_FILE = '.orca-opencode-overlay-manifest.json'

type OpenCodeOverlayManifest = {
  topLevelEntries: string[]
  pluginEntries: string[]
}

// Why: session IDs may contain path separators and are hashed downstream; cap pathological input.
function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

function toSafeDirName(id: string): string {
  // Why: 32 hex chars (128 bits) makes collisions negligible and stays filesystem-portable (no base64 padding or `/`).
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

export function getOpenCodePluginSource(): string {
  return getOpenCodeFamilyPluginSource('/hook/opencode', { emitSessionStart: true })
}

export function getOpenCodeFamilyPluginSource(
  hookPathname: string,
  options: { emitSessionStart: boolean }
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

// Why: installs the plugin into OPENCODE_CONFIG_DIR so it POSTs to the shared agent-hooks server, unifying OpenCode status with Claude/Codex/Gemini (the old loopback-IPC path never reached agentStatusByPaneKey).
export class OpenCodeHookService {
  clearPty(_ptyId: string): void {
    // Why: no-op — config dirs are app/source-scoped now, and recursive delete on the main-process hot path could freeze on Windows.
  }

  buildPtyEnv(ptyId: string, existingConfigDir?: string | undefined): Record<string, string> {
    if (!isUsableId(ptyId)) {
      // Why: on a bad id, still preserve a user-set OPENCODE_CONFIG_DIR; only the Orca status plugin is forfeited.
      return existingConfigDir ? { OPENCODE_CONFIG_DIR: existingConfigDir } : {}
    }

    if (!existingConfigDir) {
      // Why: share one config root so OpenCode's plugin deps don't churn node_modules per terminal.
      const configDir = this.writeSharedPluginConfig()
      if (!configDir) {
        return {}
      }
      return { OPENCODE_CONFIG_DIR: configDir }
    }

    // Why: don't mkdir the user's (possibly typoed) path — that's the config-replacement failure mode in docs/opencode-config-dir-collision.md; let OpenCode surface it.
    if (!existsSync(existingConfigDir)) {
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }

    const overlayDir = this.getSourceOverlayDir(existingConfigDir)

    try {
      mkdirSync(overlayDir, { recursive: true })
      this.mirrorUserConfig(existingConfigDir, overlayDir)
      this.writePluginIntoOverlay(overlayDir)
    } catch {
      // Why: best-effort — symlink creation needs Windows developer mode (else EPERM) and userData may be read-only; preserve the user's config over dropping their auth/models/keymap.
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }

    return { OPENCODE_CONFIG_DIR: overlayDir }
  }

  private getOverlayRoot(): string {
    return join(getAppEnvironment().getPath('userData'), OPENCODE_OVERLAY_DIR)
  }

  private getSourceOverlayDir(sourceConfigDir: string): string {
    return join(this.getOverlayRoot(), toSafeDirName(`source:${sourceConfigDir}`))
  }

  private getSharedConfigDir(): string {
    return join(
      getAppEnvironment().getPath('userData'),
      OPENCODE_LEGACY_HOOKS_DIR,
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
      if (entryName === ORCA_OPENCODE_PLUGIN_FILE) {
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
            if (pluginEntry.name === ORCA_OPENCODE_PLUGIN_FILE) {
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
    const pluginPath = join(pluginsDir, ORCA_OPENCODE_PLUGIN_FILE)
    try {
      unlinkSync(pluginPath)
    } catch {
      // File may not exist on a fresh overlay; a real failure surfaces on writeFileSync below.
    }
    writeFileSync(pluginPath, getOpenCodePluginSource())
  }

  private writeSharedPluginConfig(): string | null {
    const configDir = this.getSharedConfigDir()
    const pluginsDir = join(configDir, 'plugins')
    try {
      mkdirSync(pluginsDir, { recursive: true })
      writeFileSync(join(pluginsDir, ORCA_OPENCODE_PLUGIN_FILE), getOpenCodePluginSource())
    } catch {
      // Why: userData can be locked on Windows (EPERM/EBUSY); plugin is non-critical, so spawn without it.
      return null
    }
    return configDir
  }
}

export const openCodeHookService = new OpenCodeHookService()
export const _internals = {
  getOpenCodePluginSource,
  isUsableId,
  toSafeDirName
}
