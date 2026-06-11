import { app } from 'electron'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'
import { getMimoPluginSource } from './plugin-source'

const ORCA_MIMO_PLUGIN_FILE = 'orca-mimo-status.js'
const MIMO_LEGACY_HOOKS_DIR = 'mimo-hooks'
const MIMO_OVERLAY_DIR = 'mimo-config-overlays'
const MIMO_SHARED_CONFIG_DIR = 'shared'
const MIMO_OVERLAY_MANIFEST_FILE = '.orca-mimo-overlay-manifest.json'

type MimoOverlayManifest = {
  topLevelEntries: string[]
  pluginEntries: string[]
}

// Why: the id passed in by pty.ts's daemon path is a sessionId shaped like
// "<worktreeId>@@<uuid>" where worktreeId itself contains "::" and a
// filesystem path (slashes, colons). Earlier the id was a simple numeric
// counter, so rejecting anything with "/" or ":" was a safe guard against
// path traversal. After the daemon-parity refactor (#1148) the sessionId
// shape changed, and the old regex silently rejected every legitimate id,
// leaving MIMO_CONFIG_DIR unset and the plugin never loading.
//
// Keep an input-bounds guard (non-empty, bounded length) for defense in
// depth, and derive the on-disk directory name via hash so any caller's id —
// including ones containing path separators — produces a short, stable,
// filesystem-safe name. Hashing also eliminates path-traversal risk at the
// source: the directory name is always 32 hex chars, never a prefix/suffix
// of the caller's input.
// Why: 1024 is a generous sanity cap — daemon-shaped ids embed a worktree
// filesystem path plus "@@<uuid>", and this bound prevents pathological inputs
// from burning CPU in the SHA-256 step. Since the id is hashed anyway, 1024
// is decoupled from PATH_MAX.
function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

function toSafeDirName(id: string): string {
  // Why: SHA-256 truncated to 32 hex chars (128 bits) is ample for a
  // per-session directory name — collisions require ~2^64 concurrent sessions
  // to become likely, far beyond any real workload. Hex keeps the name
  // portable across all filesystems (no base64 padding, no `/`).
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

// Why: Mimo hooks used to run their own loopback HTTP server + IPC
// channel (pty:mimo-status). That pathway produced a synthetic terminal
// title but never entered agentStatusByPaneKey, so the unified dashboard
// never saw Mimo sessions. The service now only installs the plugin
// file into MIMO_CONFIG_DIR — the plugin POSTs directly to the shared
// agent-hooks server (/hook/mimo), so Mimo rides the same status
// pipeline as Claude/Codex/Gemini.
export class MimoHookService {
  clearPty(_ptyId: string): void {
    // Why: Mimo can materialize thousands of plugin runtime files under
    // MIMO_CONFIG_DIR. This teardown runs on Electron's main process hot
    // path, so recursive deletion here can freeze the whole app on Windows
    // while Node, antivirus, or indexing still holds file handles.
    //
    // Current builds use app/source-scoped config dirs, not PTY-scoped dirs,
    // so there is no live PTY-owned Mimo filesystem state to remove.
  }

  buildPtyEnv(ptyId: string, existingConfigDir?: string | undefined): Record<string, string> {
    if (!isUsableId(ptyId)) {
      // Why: defense-in-depth. If the id fails the bounds guard, a user-set
      // MIMO_CONFIG_DIR should still be preserved so Mimo loads the
      // user's own config — only the Orca status plugin is forfeited.
      return existingConfigDir ? { MIMO_CONFIG_DIR: existingConfigDir } : {}
    }

    if (!existingConfigDir) {
      // Why: Mimo may install plugin dependencies under this root. Sharing
      // it prevents per-terminal node_modules churn and teardown freezes.
      const configDir = this.writeSharedPluginConfig()
      if (!configDir) {
        return {}
      }
      return { MIMO_CONFIG_DIR: configDir }
    }

    // Why: do NOT `mkdir -p` the user's typoed path — overriding it with an
    // Orca-owned dir is the exact config-replacement failure mode documented in
    // docs/opencode-config-dir-collision.md. Let Mimo surface the typo on
    // its own; we only forfeit our status plugin for this pane.
    if (!existsSync(existingConfigDir)) {
      return { MIMO_CONFIG_DIR: existingConfigDir }
    }

    const overlayDir = this.getSourceOverlayDir(existingConfigDir)

    try {
      mkdirSync(overlayDir, { recursive: true })
      this.mirrorUserConfig(existingConfigDir, overlayDir)
      this.writePluginIntoOverlay(overlayDir)
    } catch {
      // Why: overlay creation is best-effort. Symlink-creation can fail on
      // Windows without developer mode (EPERM), userData can be read-only on
      // locked-down corporate machines, etc. In every case, preserve the
      // user's MIMO_CONFIG_DIR — a missing status plugin is a vastly
      // smaller harm than silently dropping the user's auth/models/keymap.
      return { MIMO_CONFIG_DIR: existingConfigDir }
    }

    return { MIMO_CONFIG_DIR: overlayDir }
  }

  private getOverlayRoot(): string {
    return join(app.getPath('userData'), MIMO_OVERLAY_DIR)
  }

  private getSourceOverlayDir(sourceConfigDir: string): string {
    return join(this.getOverlayRoot(), toSafeDirName(`source:${sourceConfigDir}`))
  }

  private getSharedConfigDir(): string {
    return join(app.getPath('userData'), MIMO_LEGACY_HOOKS_DIR, MIMO_SHARED_CONFIG_DIR)
  }

  private readOverlayManifest(overlayDir: string): MimoOverlayManifest {
    try {
      const parsed = JSON.parse(
        readFileSync(join(overlayDir, MIMO_OVERLAY_MANIFEST_FILE), 'utf8')
      ) as Partial<MimoOverlayManifest>
      return {
        topLevelEntries: Array.isArray(parsed.topLevelEntries) ? parsed.topLevelEntries : [],
        pluginEntries: Array.isArray(parsed.pluginEntries) ? parsed.pluginEntries : []
      }
    } catch {
      return { topLevelEntries: [], pluginEntries: [] }
    }
  }

  private writeOverlayManifest(overlayDir: string, manifest: MimoOverlayManifest): void {
    writeFileSync(
      join(overlayDir, MIMO_OVERLAY_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
  }

  private clearManifestEntries(overlayDir: string, manifest: MimoOverlayManifest): void {
    for (const entryName of manifest.topLevelEntries) {
      safeRemoveTree(join(overlayDir, entryName))
    }

    const overlayPluginsDir = join(overlayDir, 'plugins')
    for (const entryName of manifest.pluginEntries) {
      if (entryName === ORCA_MIMO_PLUGIN_FILE) {
        continue
      }
      safeRemoveTree(join(overlayPluginsDir, entryName))
    }
  }

  // Why: walks the user's MIMO_CONFIG_DIR top-level entries. The
  // `plugins/` subdirectory gets created as a real directory in the overlay
  // so Orca can drop a sibling file alongside the user's plugins; everything
  // else (mimo.json, auth.json, themes/, etc.) is mirrored as a single
  // top-level entry via symlink/junction so user edits propagate live on
  // POSIX (and on Windows-with-developer-mode) without copying files.
  private mirrorUserConfig(sourceDir: string, overlayDir: string): void {
    const previousManifest = this.readOverlayManifest(overlayDir)
    // Why: source-scoped overlays persist across terminals. Only remove paths
    // Orca previously mirrored, so deleted/replaced user config cannot stay
    // stale while Mimo-owned runtime dirs such as node_modules survive.
    this.clearManifestEntries(overlayDir, previousManifest)

    const nextManifest: MimoOverlayManifest = { topLevelEntries: [], pluginEntries: [] }

    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = join(sourceDir, entry.name)

      if (entry.name === 'plugins') {
        // Why: check isSymbolicLink BEFORE isDirectory — a Windows junction
        // can report both as true on a Dirent, and we must take the symlink
        // branch so the per-entry mirroring (not a single mirrorEntry call
        // that would create a symlink at <overlay>/plugins) handles it.
        const isSymlink = entry.isSymbolicLink()
        let isLinkPointingToDir = false
        if (isSymlink) {
          try {
            isLinkPointingToDir = statSync(sourcePath).isDirectory()
          } catch {
            // Why: broken symlink (target missing) or permission error — fall
            // through to the default mirrorEntry path so the dangling link is
            // mirrored verbatim rather than write-through-resolved.
            isLinkPointingToDir = false
          }
        }

        if ((!isSymlink && entry.isDirectory()) || isLinkPointingToDir) {
          // Why: when the user's plugins/ is a symlink-to-dir, resolve to the
          // real target so readdir returns the actual entries and child paths
          // join against the resolved root. mirrorEntry then creates symlinks
          // pointing into the resolved real plugins (not back through the
          // user's link), and <overlay>/plugins itself stays a real dir so
          // writePluginIntoOverlay can never write through to the user's FS.
          const resolvedSource = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
          const overlayPluginsDir = join(overlayDir, 'plugins')
          mkdirSync(overlayPluginsDir, { recursive: true })
          for (const pluginEntry of readdirSync(resolvedSource, { withFileTypes: true })) {
            // Why: skip a user file with the same filename as Orca's plugin —
            // mirroring it here would either resolve a same-named target via
            // symlink (writePluginIntoOverlay then clobbers the user's file
            // through the link) or collide on Windows with the directory entry
            // about to be created by writePluginIntoOverlay. Either way the
            // user's plugin would be lost. Skipping yields the desired
            // semantics: Orca's status plugin runs and the user's same-named
            // plugin is shadowed for this PTY only — their source file on disk
            // is untouched.
            if (pluginEntry.name === ORCA_MIMO_PLUGIN_FILE) {
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

  // Why: write Orca's status plugin into the overlay's plugins/ dir. The
  // pre-write unlink is the load-bearing part — POSIX writeFileSync over a
  // symlink writes through to the link target, so without it a user-owned
  // plugin with this filename would be clobbered through a mirrored link.
  // Skipping the same-named user file in mirrorUserConfig already prevents
  // the link from being created, but the unlink keeps this function safe
  // even if a stale overlay slips through with the link still in place.
  private writePluginIntoOverlay(overlayDir: string): void {
    const pluginsDir = join(overlayDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const pluginPath = join(pluginsDir, ORCA_MIMO_PLUGIN_FILE)
    try {
      unlinkSync(pluginPath)
    } catch {
      // No-op: file may not exist on a fresh overlay. Any persistent failure
      // (e.g. permissions) will surface on the writeFileSync below.
    }
    writeFileSync(pluginPath, getMimoPluginSource())
  }

  private writeSharedPluginConfig(): string | null {
    const configDir = this.getSharedConfigDir()
    const pluginsDir = join(configDir, 'plugins')
    try {
      mkdirSync(pluginsDir, { recursive: true })
      writeFileSync(join(pluginsDir, ORCA_MIMO_PLUGIN_FILE), getMimoPluginSource())
    } catch {
      // Why: on Windows, userData directories can be locked by antivirus or
      // indexers (EPERM/EBUSY). Plugin config is non-critical — the PTY should
      // still spawn without the Mimo status plugin.
      return null
    }
    return configDir
  }
}

export const mimoHookService = new MimoHookService()
export const _internals = {
  getMimoPluginSource,
  isUsableId,
  toSafeDirName
}
