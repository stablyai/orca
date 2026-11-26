import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { format } from 'node:util'
import { syncCodexGlobalInstructionsIntoManagedHome } from '../homes/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { getCodexConfigSyncStatus } from './config-sync-stall'
import { getCodexSettingsBaselinePath } from './config-settings-baseline'
import { MAX_AGENT_STATE_FILE_BYTES } from '../agent-state-file-reader'
import { withHookPassEditGuard } from '../../hooks/installation/codex-hook-pass-edit-guard'
import {
  CODEX_CONFIG_SYNC_WSL_PROTOCOL,
  type CodexConfigSyncWslHomeResult,
  type CodexConfigSyncWslOutput
} from './codex-config-sync-wsl-protocol'

/** `sync --system-home <dir> --runtime-home <dir>... --protocol 1`, run inside the distro. */
export function runCodexConfigSyncWslPass(argv: readonly string[]): CodexConfigSyncWslOutput {
  const [mode, ...rest] = argv
  if (mode !== 'sync') {
    throw new Error(`Unknown Codex config sync mode: ${mode}`)
  }
  const runtimeHomes: string[] = []
  let systemHome = ''
  let protocol = ''
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value = ''] = [rest[index], rest[index + 1]]
    if (flag === '--runtime-home') {
      runtimeHomes.push(value)
    } else if (flag === '--system-home') {
      systemHome = value
    } else if (flag === '--protocol') {
      protocol = value
    } else {
      throw new Error(`Unknown Codex config sync argument: ${flag}`)
    }
  }
  if (protocol !== String(CODEX_CONFIG_SYNC_WSL_PROTOCOL)) {
    throw new Error(`Unsupported Codex config sync protocol: ${protocol}`)
  }
  const roots = allowedRoots()
  for (const path of [systemHome, ...runtimeHomes]) {
    assertAllowedPath(path, roots)
  }
  return {
    protocol: CODEX_CONFIG_SYNC_WSL_PROTOCOL,
    homes: runtimeHomes.map((runtimeHome) => syncHome(runtimeHome, systemHome))
  }
}

function syncHome(runtimeHome: string, systemHome: string): CodexConfigSyncWslHomeResult {
  const homes = { runtimeHomePath: runtimeHome, systemHomePath: systemHome }
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(format(...args))
  }
  try {
    syncCodexGlobalInstructionsIntoManagedHome({
      systemHomePath: systemHome,
      managedHomePath: runtimeHome
    })
    return {
      runtimeHome,
      complete: syncGuarded(homes),
      status: getCodexConfigSyncStatus(homes),
      error: null,
      warnings
    }
  } catch (error) {
    return {
      runtimeHome,
      complete: false,
      status: getCodexConfigSyncStatus(homes),
      error: error instanceof Error ? error.message : String(error),
      warnings
    }
  } finally {
    console.warn = warn
  }
}

// A Codex save landing mid-pass must not be mirrored over; redo the pass instead, as hook passes do.
function syncGuarded(homes: { runtimeHomePath: string; systemHomePath: string }): boolean {
  const paths = [
    join(homes.runtimeHomePath, 'config.toml'),
    join(homes.systemHomePath, 'config.toml'),
    getCodexSettingsBaselinePath(homes.runtimeHomePath)
  ]
  for (let attempt = 0; attempt < PASS_ATTEMPTS; attempt++) {
    const guarded = withHookPassEditGuard(
      paths,
      () => syncSystemConfigIntoManagedCodexHome({ ...homes, guestHome: true }),
      // The mirror rejects these files past the state-file limit, so hashing more is wasted.
      { maxBytes: MAX_AGENT_STATE_FILE_BYTES }
    )
    if (guarded.conflict === null) {
      return guarded.value
    }
  }
  console.warn('[codex-config] Codex kept changing its config during the sync; retrying next pass')
  return false
}

const PASS_ATTEMPTS = 3

// The guest's $HOME, Orca's account store and the Windows drive mounts, each also by its real path:
// a launch may pass a home already resolved through a link (say the store moved to another disk).
function allowedRoots(): string[] {
  const home = homedir()
  const roots = [home, join(home, '.local', 'share', 'orca', 'codex-accounts')]
  try {
    for (const line of readFileSync('/proc/mounts', 'utf-8').split('\n')) {
      const [, mountPoint, type, options = ''] = line.split(' ')
      if (mountPoint && (type === 'drvfs' || (type === '9p' && options.includes('aname=drvfs')))) {
        roots.push(mountPoint.replace(/\\040/g, ' '))
      }
    }
  } catch {
    // Without /proc/mounts only $HOME and the store are allowed.
  }
  return [...roots, ...roots.map(realPathOrNull).filter((root) => root !== null)]
}

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function assertAllowedPath(path: string, roots: readonly string[]): void {
  const resolved = resolve(path)
  const allowed =
    path.startsWith('/') &&
    roots.some((root) => root !== '/' && (resolved === root || resolved.startsWith(`${root}/`)))
  if (!allowed) {
    throw new Error(`Codex config sync refuses a path outside $HOME and drive mounts: ${path}`)
  }
}
