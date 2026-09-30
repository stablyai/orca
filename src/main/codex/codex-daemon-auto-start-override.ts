import { upsertTableSettingsInContent } from './codex-config-settings-upsert'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  joinPreservingTrailingNewline,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'

/**
 * Codex >= 0.156 auto-starts one shared app-server per CODEX_HOME that runs every
 * later session's hooks and tools with the first session's environment and dies
 * with it. Every home Orca owns carries `[features] daemon_auto_start = false`, so
 * launches that skip the `codex` shell function's `--no-daemon` (cmd.exe, scripts,
 * absolute paths) run their own server; it also lets Codex start at all in homes
 * whose socket path exceeds `sun_path`. It does not stop a launch joining a server
 * already running there, and profile-level (`[profiles.X.features]`) and `-c`
 * overrides still win.
 */
// Why: older Orca builds strip only this exact text, so it must never change.
export const CODEX_DAEMON_OVERRIDE_MARKER = '# orca: CODEX_HOME too long for the daemon socket'
const DAEMON_OVERRIDE_RAW = `false ${CODEX_DAEMON_OVERRIDE_MARKER}`

const unguardableHomesWarned = new Set<string>()
const overriddenHomesWarned = new Set<string>()

/**
 * Forces `daemon_auto_start = false` into a home Orca owns, even over a user's
 * explicit `true` mirrored from ~/.codex, matching the shell function's
 * unconditional `--no-daemon`. Callers pass only Orca's runtime homes; the user's
 * ~/.codex reaches the mirror only as its read-only source. `ORCA_CODEX_ISOLATE=0`
 * does not re-enable it: forcing auto-start in a home past `sun_path` is fatal.
 */
export function applyCodexDaemonAutoStartOverride(
  config: string,
  orcaOwnedHomePath: string
): string {
  // Why: upsert rewrites an existing daemon_auto_start line in place, so re-applying is a no-op.
  const guarded = upsertTableSettingsInContent(
    config,
    'features',
    new Map([['daemon_auto_start', DAEMON_OVERRIDE_RAW]])
  )
  const applied = guarded.includes(CODEX_DAEMON_OVERRIDE_MARKER)
  if (applied && hasUserDaemonAutoStartEnabled(config)) {
    warnOncePerHome(
      overriddenHomesWarned,
      orcaOwnedHomePath,
      `[codex-config] A Codex config sets features.daemon_auto_start = true; Orca turns it off in its own Codex home ${orcaOwnedHomePath} so each Orca tab runs its own Codex server. Orca does not change this setting in ~/.codex/config.toml; a value set only inside ${orcaOwnedHomePath} is replaced there.`
    )
  }
  if (!applied && !/\bdaemon_auto_start\s*=\s*false\b/.test(guarded)) {
    // Why: an inline `features = {...}` or `[[features]]` blocks the upsert; say so once instead of failing silently.
    warnOncePerHome(
      unguardableHomesWarned,
      orcaOwnedHomePath,
      `[codex-config] Could not turn off Codex daemon auto-start in ${orcaOwnedHomePath}: its config defines features in a form Orca cannot extend. Codex may start a shared background server that runs every tab's hooks with one tab's environment, and in a long home may fail with "path must be shorter than SUN_LEN"; rewrite features in ~/.codex/config.toml as a [features] table so Orca can add the setting to its own copy.`
    )
  }
  return guarded
}

function warnOncePerHome(warned: Set<string>, homePath: string, message: string): void {
  if (!warned.has(homePath)) {
    warned.add(homePath)
    console.warn(message)
  }
}

function isCodexDaemonOverrideLine(line: string): boolean {
  return line.trimEnd().endsWith(CODEX_DAEMON_OVERRIDE_MARKER)
}

/** True when the config sets `features.daemon_auto_start = true` in a line Orca did not write. */
function hasUserDaemonAutoStartEnabled(config: string): boolean {
  let scan = createTomlLineScanState()
  let inPreamble = true
  let inFeatures = false
  for (const line of config.split('\n')) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    if (!structural) {
      continue
    }
    const header = getTomlTableHeader(line)
    if (header) {
      const table = parseTomlTableHeaderPath(header)
      inPreamble = false
      inFeatures = table?.isArray === false && table.segments.join('.') === 'features'
      continue
    }
    const key = parseTomlKeyPath(line)
    if (!key || line[key.end] !== '=' || isCodexDaemonOverrideLine(line)) {
      continue
    }
    const path = key.segments.join('.')
    const value = line.slice(key.end + 1)
    if (
      ((inFeatures && path === 'daemon_auto_start') ||
        (inPreamble && path === 'features.daemon_auto_start')) &&
      /^\s*true\b/.test(value)
    ) {
      return true
    }
    if (inPreamble && path === 'features' && /\bdaemon_auto_start\s*=\s*true\b/.test(value)) {
      return true
    }
  }
  return false
}

/** True when a config holds nothing but Orca's daemon override, i.e. no user settings. */
export function isOnlyCodexDaemonOverride(config: string): boolean {
  return (
    config.includes(CODEX_DAEMON_OVERRIDE_MARKER) && stripCodexDaemonOverride(config).trim() === ''
  )
}

/**
 * Removes only lines Orca wrote, plus a `[features]` table left empty by that
 * removal, so the override never leaks into the user's real ~/.codex.
 */
export function stripCodexDaemonOverride(config: string): string {
  if (!config.includes(CODEX_DAEMON_OVERRIDE_MARKER)) {
    return config
  }
  const usesCrlf = config.includes('\r\n')
  const lines = config.split('\n')
  const kept: string[] = []
  let featuresHeaderIndex = -1
  let removedFromFeatures = false
  const dropEmptyFeaturesTable = (): void => {
    const body = kept.slice(featuresHeaderIndex + 1)
    if (featuresHeaderIndex !== -1 && removedFromFeatures && body.every((l) => l.trim() === '')) {
      kept.length = featuresHeaderIndex
      while (kept.at(-1)?.trim() === '') {
        kept.pop()
      }
      if (kept.length > 0) {
        // Why: keep one blank line before the next table.
        kept.push(usesCrlf ? '\r' : '')
      }
    }
  }
  let scan = createTomlLineScanState()
  for (const line of lines) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    if (structural && isCodexDaemonOverrideLine(line)) {
      removedFromFeatures ||= featuresHeaderIndex !== -1
      continue
    }
    const header = structural ? getTomlTableHeader(line) : null
    if (header) {
      dropEmptyFeaturesTable()
      const table = parseTomlTableHeaderPath(header)
      const isFeatures = table?.isArray === false && table.segments.join('.') === 'features'
      featuresHeaderIndex = isFeatures ? kept.length : -1
      removedFromFeatures = false
    }
    kept.push(line)
  }
  dropEmptyFeaturesTable()
  while (kept.at(-1)?.trim() === '') {
    kept.pop()
  }
  return kept.length === 0 ? '' : joinPreservingTrailingNewline(kept, usesCrlf)
}
