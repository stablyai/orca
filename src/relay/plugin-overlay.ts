// Why: relay-side equivalent of Orca's userData-backed plugin overlay system.
// Orca's local OpenCodeHookService and PiTitlebarExtensionService each
// materialize a per-PTY directory containing a single status plugin file and
// inject OPENCODE_CONFIG_DIR / PI_CODING_AGENT_DIR pointing at it. Those
// paths describe the *local* filesystem and would resolve to nothing on a
// remote box, so when a PTY runs on the relay, the relay must do the same
// materialization on its own disk.
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
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const RELAY_HOOKS_DIR = '.orca-relay'
const OPENCODE_OVERLAY_SUBDIR = 'opencode-overlays'
const PI_OVERLAY_SUBDIR = 'pi-overlays'
const OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
const PI_EXTENSION_FILE = 'orca-agent-status.ts'

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
  /** Source body of `orca-agent-status.ts` to drop into <overlay>/.pi/agent/. */
  piExtensionSource?: string
}

export class PluginOverlayManager {
  private opencodePluginSource: string | null = null
  private piExtensionSource: string | null = null
  private opencodeRoot: string
  private piRoot: string

  constructor(opts?: { homeDir?: string }) {
    const home = opts?.homeDir ?? homedir()
    this.opencodeRoot = join(home, RELAY_HOOKS_DIR, OPENCODE_OVERLAY_SUBDIR)
    this.piRoot = join(home, RELAY_HOOKS_DIR, PI_OVERLAY_SUBDIR)
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
      this.piExtensionSource = sources.piExtensionSource
    }
  }

  hasOpenCodeSource(): boolean {
    return this.opencodePluginSource !== null
  }

  hasPiSource(): boolean {
    return this.piExtensionSource !== null
  }

  /** Materialize the OpenCode plugin overlay for `id` (typically the
   *  renderer-supplied paneKey or, fallback, the relay-internal pty-id) and
   *  return the directory path. Returns null when no source is cached or
   *  the overlay write fails — caller falls back to no plugin (the agent
   *  CLI runs without status reporting), which is the existing fail-open
   *  behavior on the local side. */
  materializeOpenCode(id: string): string | null {
    if (!this.opencodePluginSource || !isUsableId(id)) {
      return null
    }
    const dir = join(this.opencodeRoot, safeDirName(id))
    const pluginsDir = join(dir, 'plugins')
    try {
      mkdirSync(pluginsDir, { recursive: true })
      writeFileSync(join(pluginsDir, OPENCODE_PLUGIN_FILE), this.opencodePluginSource)
      return dir
    } catch (err) {
      process.stderr.write(
        `[plugin-overlay] failed to materialize OpenCode overlay: ${err instanceof Error ? err.message : String(err)}\n`
      )
      return null
    }
  }

  /** Materialize the Pi extension overlay for `id` and return the directory
   *  path that should be assigned to PI_CODING_AGENT_DIR. The path layout
   *  (`<overlay>/.pi/agent/`) mirrors Pi's expected agent dir structure. */
  materializePi(id: string): string | null {
    if (!this.piExtensionSource || !isUsableId(id)) {
      return null
    }
    const root = join(this.piRoot, safeDirName(id))
    const agentDir = join(root, '.pi', 'agent')
    try {
      mkdirSync(agentDir, { recursive: true })
      writeFileSync(join(agentDir, PI_EXTENSION_FILE), this.piExtensionSource)
      // Why: Pi consumes PI_CODING_AGENT_DIR as the root that *contains* .pi.
      // Returning `root` (not `agentDir`) matches the local
      // PiTitlebarExtensionService convention.
      return root
    } catch (err) {
      process.stderr.write(
        `[plugin-overlay] failed to materialize Pi overlay: ${err instanceof Error ? err.message : String(err)}\n`
      )
      return null
    }
  }

  /** Drop a paneKey's overlay dirs on PTY exit. Best-effort; rmSync over a
   *  recursive tree may fail on exotic filesystems but the worst-case
   *  outcome is unbounded growth on a long-lived relay, which the per-pane
   *  caches alone do not bound. */
  clearOverlay(id: string): void {
    if (!isUsableId(id)) {
      return
    }
    const safe = safeDirName(id)
    for (const root of [this.opencodeRoot, this.piRoot]) {
      try {
        rmSync(join(root, safe), { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  }
}
