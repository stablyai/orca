// Pure checks for the boot-twice harness (boot-twice.ts): what a second boot of the same disk may
// change, and whether the image carries the pinned tools and this tree's entry points.
import type { GoldenImageManifest } from '../golden-image'

export type DiffEntry = { kind: 'A' | 'C' | 'D'; path: string }

/** `docker diff` output: one `<A|C|D> <path>` line per changed path. */
export function parseDockerDiff(text: string): DiffEntry[] {
  const entries: DiffEntry[] = []
  for (const line of text.split('\n')) {
    const match = /^([ACD]) (\/.*)$/.exec(line.trim())
    if (match) {
      entries.push({ kind: match[1] as DiffEntry['kind'], path: match[2]! })
    }
  }
  return entries
}

/**
 * What any boot may write: runtime state, logs and the per-boot config the start script rewrites.
 * Everything else a second boot touches (/opt, /usr, /etc, package caches, node_modules) is an
 * install that should have happened once, in the image or on the first boot.
 */
export function bootStatePaths(home: string): readonly string[] {
  return [
    // orca-sandbox-start: boot id, pids, ready file, logs, start lock, git-setup marks.
    `${home}/.orca-sandbox`,
    // orcad's own data directory (device identity, sessions, logs).
    `${home}/.orcad-data`,
    // The start script's git identity fallbacks (written only when missing or on an old default).
    `${home}/.gitconfig`,
    // orca-sandbox-env rewrites Codex's managed config block and OpenCode's managed provider list on every start.
    `${home}/.codex/config.toml`,
    `${home}/.config/opencode/.orca-managed-disabled-providers`,
    // orcad reads OpenCode's session database at start; SQLite readers recreate its WAL and index files.
    `${home}/.local/share/opencode/opencode.db-shm`,
    `${home}/.local/share/opencode/opencode.db-wal`,
    // Node's compile cache: orcad's node adds or refreshes entries for code it compiles. A cache, not an install.
    '/opt/orca/compile-cache',
    '/tmp',
    '/var/tmp',
    '/run'
  ]
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** Changes outside bootStatePaths. A changed directory that only contains allowed paths is fine. */
export function unexpectedChanges(entries: readonly DiffEntry[], home: string): DiffEntry[] {
  const allowed = bootStatePaths(home)
  return entries.filter(({ kind, path }) => {
    if (/(^|\/)node_modules(\/|$)/.test(path)) {
      return true
    }
    if (allowed.some((prefix) => under(path, prefix))) {
      return false
    }
    // `C /home/ubuntu`: a parent directory of an allowed path changed its mtime.
    return !(kind === 'C' && allowed.some((prefix) => prefix.startsWith(`${path}/`)))
  })
}

/** One pinned tool: where its version is read in the image and the string it must contain. */
export type PinnedTool = { name: string; expect: string; source: 'package' | 'binary' }

/** Every version the manifest pins that the image can report. */
export function pinnedTools(manifest: GoldenImageManifest): PinnedTool[] {
  const tools: PinnedTool[] = manifest.agentCliPackages.map((spec) => {
    const at = spec.lastIndexOf('@')
    return { name: spec.slice(0, at), expect: spec.slice(at + 1), source: 'package' }
  })
  if (manifest.gh.version) {
    tools.push({ name: 'gh', expect: `gh version ${manifest.gh.version}`, source: 'binary' })
  }
  if (manifest.cursorAgent) {
    tools.push({ name: 'cursor-agent', expect: manifest.cursorAgent.version, source: 'binary' })
  }
  if (manifest.chrome) {
    // The .deb's "157.0.8103.38-1" reports itself as "Google Chrome 157.0.8103.38".
    tools.push({ name: 'google-chrome', expect: manifest.chrome.version.replace(/-\d+$/, ''), source: 'binary' })
  }
  return tools
}

/** Observed versions: npm package.json `version` by package name, else a binary's `--version` line. */
export type ObservedVersions = Record<string, string | null>

export function versionMismatches(tools: readonly PinnedTool[], observed: ObservedVersions): string[] {
  const problems: string[] = []
  for (const tool of tools) {
    const seen = observed[tool.name] ?? null
    if (seen === null) {
      problems.push(`${tool.name}: missing (pinned ${tool.expect})`)
    } else if (tool.source === 'package' ? seen !== tool.expect : !seen.includes(tool.expect)) {
      problems.push(`${tool.name}: ${JSON.stringify(seen)} does not match the pin ${tool.expect}`)
    }
  }
  return problems
}

/** Entry points in the image whose bytes differ from this tree's image/vm sources. */
export function entryPointMismatches(expected: Record<string, string>, installed: Record<string, string | null>): string[] {
  return Object.entries(expected)
    .filter(([name, sha]) => installed[name] !== sha)
    .map(([name]) => (installed[name] ? `${name}: differs from image/vm/${name}` : `${name}: missing from /opt/orca/bin`))
}

/**
 * Commands that install, fetch or redo first-run work. Any of them in a second boot is a step that
 * should have run once. Offline they fail fast and quietly, so the command line is the evidence.
 */
const INSTALLERS = [
  /(^|\/)(apt|apt-get|dpkg|pip3?|curl|wget)( |$)/,
  /(^|\/)npm (install|i|ci|add) /,
  /(^|\/)git( -[Cc] \S+)* (clone|fetch|pull)( |$)/,
  /(^|\/)opencode models( |$)/,
  /(^|\/)tar (-?x|--extract)/
]

/** The installer command lines among a boot's sampled `/proc/<pid>/cmdline`s. */
export function installerCommands(commands: readonly string[]): string[] {
  return [...new Set(commands.map((line) => line.trim()).filter((line) => line && INSTALLERS.some((pattern) => pattern.test(line))))]
}
