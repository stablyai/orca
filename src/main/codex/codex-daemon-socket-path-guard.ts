import { realpathSync } from 'node:fs'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { unixSocketPathByteLimit } from '../../shared/unix-socket-path-limit'
import { upsertTableSettingsInContent } from './codex-config-settings-upsert'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  joinPreservingTrailingNewline,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlTableHeaderPath } from './config-toml-key-path'

/**
 * Codex >= 0.157 auto-starts a background app-server daemon and its client
 * connects to `<CODEX_HOME>/app-server-control/app-server-control.sock`. Orca's
 * managed homes live under userData, which makes that path longer than
 * `sun_path`, so every interactive `codex` fails with "path must be shorter
 * than SUN_LEN". Only for such homes, Orca turns daemon auto-start off.
 */
const DAEMON_SOCKET_SEGMENTS = ['app-server-control', 'app-server-control.sock']
export const CODEX_DAEMON_OVERRIDE_MARKER = '# orca: CODEX_HOME too long for the daemon socket'
const DAEMON_OVERRIDE_RAW = `false ${CODEX_DAEMON_OVERRIDE_MARKER}`

export function codexDaemonSocketPath(homePath: string, platform = process.platform): string {
  const wsl = parseWslUncPath(homePath)
  if (wsl) {
    return [wsl.linuxPath.replace(/\/+$/, ''), ...DAEMON_SOCKET_SEGMENTS].join('/')
  }
  // Why: Codex canonicalizes CODEX_HOME before building the socket path, so a
  // short symlinked alias still resolves to the long real path. Its
  // AbsolutePathBuf strips the Windows \\?\ prefix, so none is counted here.
  let canonical = homePath
  try {
    canonical = realpathSync.native(homePath)
  } catch {
    // Unresolvable homes are measured as spelled.
  }
  const separator = platform === 'win32' ? '\\' : '/'
  return [canonical.replace(/[\\/]+$/, ''), ...DAEMON_SOCKET_SEGMENTS].join(separator)
}

export function codexDaemonSocketPathExceedsLimit(
  homePath: string,
  platform = process.platform
): boolean {
  // Why: WSL homes run Linux Codex; Windows Codex's uds_windows also uses a 108-byte sun_path.
  const os = platform === 'darwin' && !parseWslUncPath(homePath) ? 'darwin' : 'linux'
  const socketPath = codexDaemonSocketPath(homePath, platform)
  return Buffer.byteLength(socketPath, 'utf8') > unixSocketPathByteLimit(os)
}

const unguardableHomesWarned = new Set<string>()

/** Applies (or removes) Orca's daemon override so it tracks the home's current path. */
export function applyCodexDaemonSocketGuard(
  config: string,
  homePath: string,
  platform = process.platform
): string {
  if (!codexDaemonSocketPathExceedsLimit(homePath, platform)) {
    return stripCodexDaemonOverride(config)
  }
  // Why: upsert rewrites an existing daemon_auto_start line in place, so re-applying is a no-op.
  const guarded = upsertTableSettingsInContent(
    config,
    'features',
    new Map([['daemon_auto_start', DAEMON_OVERRIDE_RAW]])
  )
  if (
    !guarded.includes(CODEX_DAEMON_OVERRIDE_MARKER) &&
    !/\bdaemon_auto_start\s*=\s*false\b/.test(guarded) &&
    !unguardableHomesWarned.has(homePath)
  ) {
    // Why: an inline `features = {...}` or `[[features]]` blocks the upsert; say so once instead of failing silently.
    unguardableHomesWarned.add(homePath)
    console.warn(
      `[codex-config] Could not turn off Codex daemon auto-start in ${homePath}: its config defines features in a form Orca cannot extend. Codex may fail with "path must be shorter than SUN_LEN"; add daemon_auto_start = false to features in ~/.codex/config.toml.`
    )
  }
  return guarded
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
    if (structural && line.trimEnd().endsWith(CODEX_DAEMON_OVERRIDE_MARKER)) {
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
