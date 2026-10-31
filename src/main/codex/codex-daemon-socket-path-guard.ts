import { realpathSync } from 'node:fs'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { unixSocketPathFits } from '../../shared/unix-socket-path-limit'
import { upsertTableSettingsInContent } from './codex-config-settings-upsert'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  joinPreservingTrailingNewline,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlTableHeaderPath } from './config-toml-key-path'

// Codex >=0.157 auto-starts a daemon; long managed homes exceed its socket's sun_path limit.
const DAEMON_SOCKET_SEGMENTS = ['app-server-control', 'app-server-control.sock']
export const CODEX_DAEMON_OVERRIDE_MARKER = '# orca: CODEX_HOME too long for the daemon socket'
const DAEMON_OVERRIDE_RAW = `false ${CODEX_DAEMON_OVERRIDE_MARKER}`

export function codexDaemonSocketPath(homePath: string, platform = process.platform): string {
  const wsl = parseWslUncPath(homePath)
  if (wsl) {
    return [wsl.linuxPath.replace(/\/+$/, ''), ...DAEMON_SOCKET_SEGMENTS].join('/')
  }
  // Codex canonicalizes CODEX_HOME, so short symlink aliases still use the long real path.
  // Its AbsolutePathBuf strips the Windows extended-path prefix before measuring.
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
  // WSL uses Linux limits; native Windows uds_windows also has a 108-byte sun_path.
  const os = platform === 'darwin' && !parseWslUncPath(homePath) ? 'darwin' : 'linux'
  return !unixSocketPathFits(codexDaemonSocketPath(homePath, platform), os)
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
    // Inline/array features tables block upsert; warn once so an ineffective guard is visible.
    unguardableHomesWarned.add(homePath)
    console.warn(
      `[codex-config] Could not turn off Codex daemon auto-start in ${homePath}: its config defines features in a form Orca cannot extend. Codex may fail with "path must be shorter than SUN_LEN"; add daemon_auto_start = false to features in ~/.codex/config.toml.`
    )
  }
  return guarded
}

export function isOnlyCodexDaemonOverride(config: string): boolean {
  return (
    config.includes(CODEX_DAEMON_OVERRIDE_MARKER) && stripCodexDaemonOverride(config).trim() === ''
  )
}

/** Remove marked lines and emptied features tables so the override never reaches the real ~/.codex. */
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
