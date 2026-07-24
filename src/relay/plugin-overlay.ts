// Why: relay-side equivalent of Orca's local agent integration installers.
// OpenCode still needs a config overlay, while Pi/OMP now get Orca-managed
// extension files installed into the remote agent homes. Host paths from the
// renderer are meaningless on SSH targets, so the relay performs the remote
// filesystem work itself.
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
// implementation rooted at $HOME/.orca-relay/ for OpenCode and at the remote
// Pi/OMP homes for those agents.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  applyConfigOverlayPlan,
  createConfigOverlayPlan,
  type ConfigOverlayPlan
} from '../main/pty/config-overlay-mirroring'
import { safeRemoveOverlay } from '../main/pty/overlay-mirror'
import {
  isManagedPiExtensionFile,
  withOrcaManagedPiExtensionMarker
} from '../main/pi/managed-extension-ownership'
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
   *  Note: existing running agents keep whatever source they loaded at
   *  process start. Future PTYs pick up the refreshed source when the relay
   *  writes plugin/extension files before spawn. */
  setSources(sources: PluginSources): void {
    if (typeof sources.opencodePluginSource === 'string') {
      this.opencodePluginSource = sources.opencodePluginSource
    }
    if (typeof sources.piExtensionSource === 'string') {
      this.piExtensionSources.pi = withOrcaManagedPiExtensionMarker(sources.piExtensionSource)
    }
    if (typeof sources.ompExtensionSource === 'string') {
      this.piExtensionSources.omp = withOrcaManagedPiExtensionMarker(sources.ompExtensionSource)
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

  private writeOpenCodePlugin(overlayDir: string): void {
    const pluginsDir = join(overlayDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const pluginPath = join(pluginsDir, OPENCODE_PLUGIN_FILE)
    try {
      unlinkSync(pluginPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
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
      let plan: ConfigOverlayPlan | null = null
      if (existingConfigDir) {
        if (!existsSync(existingConfigDir)) {
          return null
        }
        // Why: OPENCODE_CONFIG_DIR is a single config root. Mirror the user's
        // remote root into the overlay before adding Orca's plugin so status
        // reporting does not hide their auth, models, keybinds, or plugins.
        plan = createConfigOverlayPlan(existingConfigDir, {
          reservedPluginFile: OPENCODE_PLUGIN_FILE
        })
      }
      if (!safeRemoveOverlay(dir, this.opencodeRoot)) {
        throw new Error('OpenCode overlay cleanup exceeded its safety limits')
      }
      mkdirSync(dir, { recursive: true })
      if (plan) {
        applyConfigOverlayPlan(plan, dir)
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

  /** Install the Pi/OMP status extension into the remote real agent dir and
   *  return that directory. `kind` selects which Pi-compatible agent's default
   *  dir to use when `existingAgentDir` is not supplied. */
  materializePi(id: string, existingAgentDir?: string, kind: PiAgentKind = 'pi'): string | null {
    const extensionSource = this.getPiExtensionSource(kind)
    if (!extensionSource || !isUsableId(id)) {
      return null
    }
    try {
      const sourceAgentDir = existingAgentDir ?? this.getDefaultPiAgentDir(kind)
      if (existingAgentDir && !existsSync(existingAgentDir)) {
        return null
      }
      const extensionsDir = join(sourceAgentDir, 'extensions')
      mkdirSync(extensionsDir, { recursive: true })
      const extensionPath = join(extensionsDir, PI_EXTENSION_FILE)
      if (existsSync(extensionPath) && !isManagedPiExtensionFile(extensionPath)) {
        return null
      }
      writeFileSync(extensionPath, extensionSource)
      return sourceAgentDir
    } catch (err) {
      process.stderr.write(
        `[plugin-overlay] failed to install ${kind} extension: ${err instanceof Error ? err.message : String(err)}\n`
      )
      return null
    }
  }

  /** Drop a paneKey's overlay dirs on PTY exit. Best-effort and bounded; an
   *  exotic or pathological tree is logged and left for a later cleanup. */
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
        if (!safeRemoveOverlay(join(root, safe), root)) {
          process.stderr.write(
            `[plugin-overlay] overlay cleanup stopped at its safety limit: ${join(root, safe)}\n`
          )
        }
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
