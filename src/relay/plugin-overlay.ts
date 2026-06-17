// Why: relay-side equivalent of Orca's userData-backed plugin overlay system.
// Orca's local OpenCodeHookService and PiTitlebarExtensionService each
// materialize a per-PTY overlay and inject OPENCODE_CONFIG_DIR /
// PI_CODING_AGENT_DIR pointing at it. Those paths describe the local
// filesystem and would resolve to nothing on a remote box, so when a PTY runs
// on the relay, the relay must do the same materialization on its own disk.
//
// Plugin source strings ship over the JSON-RPC channel at session-ready
// (commit #7) — they are NOT bundled with the relay binary because the
// relay is versioned independently from Orca and the plugin source changes
// frequently as new agent events get added (see docs/design/agent-status-
// over-ssh.md §4 "Why ship the plugin source over the wire").
//
// We deliberately do not reuse OpenCodeHookService / PiTitlebarExtensionService
// directly: those modules import `electron` and ride on Orca's userData
// path. The relay's electron-free constraint forces a thin parallel
// implementation rooted at $HOME/.orca-relay/.

import { createHash } from 'crypto'
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
import { homedir } from 'os'
import { basename, join } from 'path'
import { mirrorEntry, safeRemoveOverlay } from '../main/pty/overlay-mirror'
import {
  isOmpPersistentSqliteEntry,
  mirrorOmpPersistentSqliteFiles
} from '../main/pty/omp-sqlite-overlay'
import { mergePiOverlayUiSettings } from '../shared/pi-overlay-ui-settings'
import type { PiAgentKind } from '../shared/pi-agent-kind'

const RELAY_HOOKS_DIR = '.orca-relay'
const OPENCODE_OVERLAY_SUBDIR = 'opencode-overlays'
const PI_OVERLAY_SUBDIR_BY_KIND: Record<PiAgentKind, string> = {
  pi: 'pi-overlays',
  omp: 'omp-overlays'
}
const OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
const PI_EXTENSION_FILE = 'orca-agent-status.ts'
const PI_AGENT_SUBDIR = 'agent'
const PI_AGENT_SETTINGS_FILE = 'settings.json'
// Why: source-dir resolution is keyed off the launching agent (Pi or OMP).
// Both consume `PI_CODING_AGENT_DIR` but default to different `~/.<kind>/agent`
// paths on the remote disk. The renderer-chosen launch command flows in via
// the relay PtyEnvAugmenter ctx; never derived from disk presence (a
// cross-agent fallback shadows the other agent's user extensions when both
// are installed).
const PI_AGENT_HOME_DIR_NAME: Record<PiAgentKind, string> = {
  pi: '.pi',
  omp: '.omp'
}

function safeDirName(input: string): string {
  // Why: paneKey embeds tabId:paneId where tabId may itself contain
  // filesystem-unsafe characters in some Orca builds. Hash to a fixed-width
  // hex name so any input produces a portable directory name.
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

export type PluginSources = {
  /** Source body of `orca-opencode-status.js` to drop into <overlay>/plugins/. */
  opencodePluginSource?: string
  /** Source body of Pi's `orca-agent-status.ts` to drop into <overlay>/extensions/. */
  piExtensionSource?: string
  /** Source body of OMP's `orca-agent-status.ts` to drop into <overlay>/extensions/. */
  ompExtensionSource?: string
}

export function getRelayPiStatusExtensionPath(agentDir: string): string {
  return join(agentDir, 'extensions', PI_EXTENSION_FILE)
}

export class PluginOverlayManager {
  private opencodePluginSource: string | null = null
  private piExtensionSources: Record<PiAgentKind, string | null> = {
    pi: null,
    omp: null
  }
  private homeDir: string
  private opencodeRoot: string
  private piRoots: Record<PiAgentKind, string>

  constructor(opts?: { homeDir?: string }) {
    const home = opts?.homeDir ?? homedir()
    this.homeDir = home
    this.opencodeRoot = join(home, RELAY_HOOKS_DIR, OPENCODE_OVERLAY_SUBDIR)
    this.piRoots = {
      pi: join(home, RELAY_HOOKS_DIR, PI_OVERLAY_SUBDIR_BY_KIND.pi),
      omp: join(home, RELAY_HOOKS_DIR, PI_OVERLAY_SUBDIR_BY_KIND.omp)
    }
  }

  /** Replace the cached source bodies. Called from relay.ts when Orca sends
   *  `agent_hook.installPlugins`. The first install enables the augmenter
   *  output; subsequent installs (e.g. Orca version upgrade in flight) refresh
   *  the cached source so future spawns see the new strings.
   *  Note: existing per-PTY overlays already on disk keep the previous source
   *  until that PTY exits — a long-running PTY does NOT pick up the new
   *  source, matching the local-Orca behavior where the plugin file is
   *  written once at spawn time. */
  setSources(sources: PluginSources): void {
    if (typeof sources.opencodePluginSource === 'string') {
      this.opencodePluginSource = sources.opencodePluginSource
    }
    if (typeof sources.piExtensionSource === 'string') {
      this.piExtensionSources.pi = sources.piExtensionSource
    }
    if (typeof sources.ompExtensionSource === 'string') {
      this.piExtensionSources.omp = sources.ompExtensionSource
    }
  }

  hasOpenCodeSource(): boolean {
    return this.opencodePluginSource !== null
  }

  hasPiSource(kind?: PiAgentKind): boolean {
    if (kind) {
      return this.getPiExtensionSource(kind) !== null
    }
    return this.piExtensionSources.pi !== null || this.piExtensionSources.omp !== null
  }

  private getPiExtensionSource(kind: PiAgentKind): string | null {
    return this.piExtensionSources[kind] ?? this.piExtensionSources.pi
  }

  private mirrorOpenCodeConfig(sourceDir: string, overlayDir: string): void {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = join(sourceDir, entry.name)

      if (entry.name === 'plugins') {
        const isSymlink = entry.isSymbolicLink()
        let isLinkPointingToDir = false
        if (isSymlink) {
          try {
            isLinkPointingToDir = statSync(sourcePath).isDirectory()
          } catch {
            isLinkPointingToDir = false
          }
        }

        if ((!isSymlink && entry.isDirectory()) || isLinkPointingToDir) {
          const resolvedSource = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
          const overlayPluginsDir = join(overlayDir, 'plugins')
          mkdirSync(overlayPluginsDir, { recursive: true })
          for (const pluginEntry of readdirSync(resolvedSource, { withFileTypes: true })) {
            if (pluginEntry.name === OPENCODE_PLUGIN_FILE) {
              continue
            }
            mirrorEntry(
              join(resolvedSource, pluginEntry.name),
              join(overlayPluginsDir, pluginEntry.name)
            )
          }
          continue
        }
      }

      mirrorEntry(sourcePath, join(overlayDir, entry.name))
    }
  }

  private writeOpenCodePlugin(overlayDir: string): void {
    const pluginsDir = join(overlayDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const pluginPath = join(pluginsDir, OPENCODE_PLUGIN_FILE)
    try {
      unlinkSync(pluginPath)
    } catch {
      // Fresh overlay or no same-named stale symlink.
    }
    writeFileSync(pluginPath, this.opencodePluginSource!)
  }

  /** Materialize the OpenCode plugin overlay for `id` (typically the
   *  renderer-supplied paneKey or, fallback, the relay-internal pty-id) and
   *  return the directory path. Returns null when no source is cached or
   *  the overlay write fails — caller falls back to no plugin (the agent
   *  CLI runs without status reporting), which is the existing fail-open
   *  behavior on the local side. */
  materializeOpenCode(id: string, existingConfigDir?: string): string | null {
    if (!this.opencodePluginSource || !isUsableId(id)) {
      return null
    }
    const dir = join(this.opencodeRoot, safeDirName(id))
    try {
      safeRemoveOverlay(dir, this.opencodeRoot)
      mkdirSync(dir, { recursive: true })
      if (existingConfigDir) {
        if (!existsSync(existingConfigDir)) {
          return null
        }
        // Why: OPENCODE_CONFIG_DIR is a single config root. Mirror the user's
        // remote root into the overlay before adding Orca's plugin so status
        // reporting does not hide their auth, models, keybinds, or plugins.
        this.mirrorOpenCodeConfig(existingConfigDir, dir)
      }
      this.writeOpenCodePlugin(dir)
      return dir
    } catch (err) {
      process.stderr.write(
        `[plugin-overlay] failed to materialize OpenCode overlay: ${err instanceof Error ? err.message : String(err)}\n`
      )
      return null
    }
  }

  private getDefaultPiAgentDir(kind: PiAgentKind): string {
    return join(this.homeDir, PI_AGENT_HOME_DIR_NAME[kind], PI_AGENT_SUBDIR)
  }

  private mirrorPiAgentDir(sourceAgentDir: string, overlayDir: string, kind: PiAgentKind): void {
    if (!existsSync(sourceAgentDir)) {
      if (kind === 'omp') {
        mirrorOmpPersistentSqliteFiles(sourceAgentDir, overlayDir)
      }
      return
    }

    for (const entry of readdirSync(sourceAgentDir, { withFileTypes: true })) {
      const sourcePath = join(sourceAgentDir, entry.name)

      if (entry.name === PI_AGENT_SETTINGS_FILE) {
        continue
      }

      if (kind === 'omp' && isOmpPersistentSqliteEntry(entry.name)) {
        continue
      }

      if (entry.name === 'extensions') {
        const isSymlink = entry.isSymbolicLink()
        let isLinkPointingToDir = false
        if (isSymlink) {
          try {
            isLinkPointingToDir = statSync(sourcePath).isDirectory()
          } catch {
            isLinkPointingToDir = false
          }
        }

        if ((!isSymlink && entry.isDirectory()) || isLinkPointingToDir) {
          const resolvedSource = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
          const overlayExtensionsDir = join(overlayDir, 'extensions')
          mkdirSync(overlayExtensionsDir, { recursive: true })
          for (const extensionEntry of readdirSync(resolvedSource, { withFileTypes: true })) {
            if (extensionEntry.name === PI_EXTENSION_FILE) {
              continue
            }
            mirrorEntry(
              join(resolvedSource, extensionEntry.name),
              join(overlayExtensionsDir, extensionEntry.name)
            )
          }
          continue
        }
      }

      mirrorEntry(sourcePath, join(overlayDir, basename(sourcePath)))
    }

    if (kind === 'omp') {
      mirrorOmpPersistentSqliteFiles(sourceAgentDir, overlayDir)
    }
  }

  private readPiSettings(sourceAgentDir: string): unknown {
    const settingsPath = join(sourceAgentDir, PI_AGENT_SETTINGS_FILE)
    if (!existsSync(settingsPath)) {
      return {}
    }

    try {
      return JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      return {}
    }
  }

  private writePiOverlaySettings(sourceAgentDir: string, overlayDir: string): void {
    // Why: relay overlays run on the remote disk, but the same Pi UI guardrails
    // need to stay overlay-local so SSH sessions do not mutate user config.
    const settings = mergePiOverlayUiSettings(this.readPiSettings(sourceAgentDir))
    writeFileSync(
      join(overlayDir, PI_AGENT_SETTINGS_FILE),
      `${JSON.stringify(settings, null, 2)}\n`
    )
  }

  /** Materialize the Pi extension overlay for `id` and return the directory
   *  path that should be assigned to PI_CODING_AGENT_DIR. `kind` selects which
   *  Pi-compatible agent's source dir to mirror when `existingAgentDir` is
   *  not supplied - defaults to 'pi' for back-compat with pre-OMP callers.
   *  NEVER fall back across kinds: a missing source dir for the chosen kind
   *  materializes the overlay from empty (Orca extensions only) rather than
   *  silently mirroring the other agent's state. */
  materializePi(id: string, existingAgentDir?: string, kind: PiAgentKind = 'pi'): string | null {
    const extensionSource = this.getPiExtensionSource(kind)
    if (!extensionSource || !isUsableId(id)) {
      return null
    }
    const root = this.piRoots[kind]
    const dir = join(root, safeDirName(id))
    try {
      const sourceAgentDir = existingAgentDir ?? this.getDefaultPiAgentDir(kind)
      if (existingAgentDir && !existsSync(existingAgentDir)) {
        return null
      }
      // Why: PI_CODING_AGENT_DIR is the whole state root for both Pi and OMP
      // (OMP inherits the env-var name from Pi by design). Mirror the remote
      // user's default agent dir so Orca's status extension does not hide auth,
      // sessions, skills, prompts, themes, or user extensions inside SSH panes.
      safeRemoveOverlay(dir, root)
      mkdirSync(dir, { recursive: true })
      this.mirrorPiAgentDir(sourceAgentDir, dir, kind)
      this.writePiOverlaySettings(sourceAgentDir, dir)
      const extensionsDir = join(dir, 'extensions')
      mkdirSync(extensionsDir, { recursive: true })
      writeFileSync(join(extensionsDir, PI_EXTENSION_FILE), extensionSource)
      return dir
    } catch (err) {
      process.stderr.write(
        `[plugin-overlay] failed to materialize ${kind} overlay: ${err instanceof Error ? err.message : String(err)}\n`
      )
      return null
    }
  }

  /** Drop a paneKey's overlay dirs on PTY exit. Best-effort; cleanup over a
   *  recursive tree may fail on exotic filesystems but the worst-case
   *  outcome is unbounded growth on a long-lived relay, which the per-pane
   *  caches alone do not bound. */
  clearOverlay(id: string): void {
    if (!isUsableId(id)) {
      return
    }
    const safe = safeDirName(id)
    // Why: sweep all overlay roots (OpenCode + each Pi-kind) because PTY exit
    // doesn't know which kind materialized this id. Per-root scoping inside
    // safeRemoveOverlay keeps each call bounded to its own tree.
    for (const root of [this.opencodeRoot, ...Object.values(this.piRoots)]) {
      try {
        safeRemoveOverlay(join(root, safe), root)
      } catch (err) {
        // Why: log the failed cleanup so a permission/IO error is observable.
        // The leak is the failure mode the per-pane cache eviction exists to
        // prevent - silent swallows would let it accumulate invisibly on
        // long-running relays.
        process.stderr.write(
          `[plugin-overlay] failed to remove overlay dir ${join(root, safe)}: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }
}
