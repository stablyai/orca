import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  hasAppImagePathEnvironment,
  resolveAppImageRuntimeIdentity
} from '../appimage-runtime-identity'
import {
  getAppImageCacheRootPath,
  isAppImageInstalledLauncherCurrent
} from './appimage-extracted-root'
import {
  ensureAppImageStableLauncher,
  removeAppImageLegacyLiveEndpoint
} from './appimage-stable-launcher'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { buildBareOrcaCliScript } from './linux-bare-orca-dispatcher'
import { quoteShell } from './cli-install-path-format'

const SHIM_DIR_NAME = 'linux-orca-cli-shim'

export type LinuxTerminalOrcaCliShimOptions = {
  userDataPath: string
  /** Test seam — defaults to the packaged resources root. */
  resourcesPath?: string | null
  /** Trusted caller override; production requires the complete AppImage runtime identity. */
  appImagePath?: string | null
  /** Test seam — defaults to $XDG_CACHE_HOME/orca/appimage. */
  appImageCacheRootPath?: string
}

// Why: on Linux the CLI installs as `orca-ide` so it never shadows the GNOME
// Orca screen reader at /usr/bin/orca — but agent-facing surfaces (skills,
// dispatch preambles, CLI hints) all invoke bare `orca`, so on stock Ubuntu an
// agent inside an Orca terminal would launch the screen reader instead
// (stablyai/orca#7904). Prepending this userData-scoped shim dir to managed-PTY
// PATH makes bare `orca` resolve to the Orca CLI inside Orca terminals only,
// leaving the user's own shells (and their screen reader) untouched.
export function ensureLinuxTerminalOrcaCliShimDir(
  options: LinuxTerminalOrcaCliShimOptions
): string | null {
  const resourcesPath =
    options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath
  const hasExplicitAppImagePath = Object.hasOwn(options, 'appImagePath')
  const runtimeIdentity = resolveAppImageRuntimeIdentity({ resourcesPath })
  if (!hasExplicitAppImagePath && hasAppImagePathEnvironment() && !runtimeIdentity) {
    return null
  }
  const appImagePath = hasExplicitAppImagePath
    ? (options.appImagePath ?? null)
    : (runtimeIdentity?.appImagePath ?? null)
  if (appImagePath) {
    return ensureAppImageShim(options, resourcesPath, appImagePath)
  }

  if (!resourcesPath) {
    return null
  }
  const launcherPath = getBundledLauncherPath('linux', resourcesPath)
  return launcherPath && existsSync(launcherPath)
    ? ensureShimForLauncher(options.userDataPath, launcherPath)
    : null
}

function ensureAppImageShim(
  options: LinuxTerminalOrcaCliShimOptions,
  resourcesPath: string | null,
  appImagePath: string
): string | null {
  if (!resourcesPath) {
    return null
  }
  const cacheRootPath = options.appImageCacheRootPath ?? getAppImageCacheRootPath()
  removeAppImageLegacyLiveEndpoint(cacheRootPath)

  const liveLauncherPath = getBundledLauncherPath('linux', resourcesPath)
  if (!liveLauncherPath || !existsSync(liveLauncherPath)) {
    return null
  }

  const stableLauncherPath = ensureAppImageStableLauncher(cacheRootPath)
  if (
    stableLauncherPath &&
    isAppImageInstalledLauncherCurrent({
      appImagePath,
      cacheRootPath
    })
  ) {
    return ensureShimForLauncher(options.userDataPath, stableLauncherPath)
  }

  const fence = captureAppImageRuntimeFence(liveLauncherPath)
  return fence
    ? ensureShimForScript(
        options.userDataPath,
        buildAppImageLiveLauncherScript(fence.launcherPath, fence)
      )
    : null
}

type AppImageRuntimeFence = {
  pid: number
  startTime: string
  runtimeRoot: string
  runtimeIdentity: string
  launcherIdentity: string
  launcherPath: string
}

function captureAppImageRuntimeFence(launcherPath: string): AppImageRuntimeFence | null {
  if (process.platform !== 'linux') {
    return null
  }
  const resolvedLauncherPath = resolve(launcherPath)
  const runtimeRoot = dirname(dirname(dirname(resolvedLauncherPath)))
  const runtimeIdentity = readFileIdentity(runtimeRoot)
  const launcherIdentity = readFileIdentity(resolvedLauncherPath)
  const startTime = readLinuxProcessStartTime(process.pid)
  return runtimeIdentity && launcherIdentity && startTime
    ? {
        pid: process.pid,
        startTime,
        runtimeRoot,
        runtimeIdentity,
        launcherIdentity,
        launcherPath: resolvedLauncherPath
      }
    : null
}

function readFileIdentity(path: string): string | null {
  try {
    const stats = statSync(path)
    return formatFileIdentity(stats)
  } catch {
    return null
  }
}

function formatFileIdentity(stats: Stats): string {
  return [
    stats.dev,
    stats.ino,
    stats.size,
    Math.floor(stats.mtimeMs / 1000),
    Math.floor(stats.ctimeMs / 1000)
  ].join(':')
}

function readLinuxProcessStartTime(pid: number): string | null {
  try {
    const content = readFileSync(join('/proc', String(pid), 'stat'), 'utf8')
    const commandEnd = content.lastIndexOf(') ')
    if (commandEnd === -1) {
      return null
    }
    const fields = content
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/)
    return fields[19] ?? null
  } catch {
    return null
  }
}

function buildAppImageLiveLauncherScript(
  launcherPath: string,
  fence: AppImageRuntimeFence
): string {
  const runtimePid = quoteShell(String(fence.pid))
  const runtimeStartTime = quoteShell(fence.startTime)
  const runtimeRoot = quoteShell(fence.runtimeRoot)
  const expectedRuntimeIdentity = quoteShell(fence.runtimeIdentity)
  const expectedLauncherIdentity = quoteShell(fence.launcherIdentity)
  const quotedLauncherPath = quoteShell(launcherPath)
  return `#!/usr/bin/env bash
runtime_pid=${runtimePid}
runtime_start_time=${runtimeStartTime}
runtime_root=${runtimeRoot}
launcher=${quotedLauncherPath}
expected_runtime_identity=${expectedRuntimeIdentity}
expected_launcher_identity=${expectedLauncherIdentity}
fail() {
  printf 'Orca CLI is unavailable; reopen Orca or register the CLI again.\\n' >&2
  exit 1
}
proc_stat_path="/proc/$runtime_pid/stat"
[[ -r "$proc_stat_path" ]] || fail
proc_stat="$(<"$proc_stat_path")" || fail
proc_fields=()
read -r -a proc_fields <<< "\${proc_stat##*) }" || fail
[[ "\${proc_fields[19]:-}" == "$runtime_start_time" ]] || fail
runtime_identity="$(stat -Lc '%d:%i:%s:%Y:%Z' -- "$runtime_root" 2>/dev/null)" || fail
[[ "$runtime_identity" == "$expected_runtime_identity" ]] || fail
launcher_identity="$(stat -Lc '%d:%i:%s:%Y:%Z' -- "$launcher" 2>/dev/null)" || fail
[[ "$launcher_identity" == "$expected_launcher_identity" ]] || fail
[[ -f "$launcher" && -x "$launcher" ]] || fail
exec "$launcher" "$@"
`
}

function ensureShimForLauncher(userDataPath: string, launcherPath: string): string | null {
  const script = buildBareOrcaCliScript(launcherPath)

  return ensureShimForScript(userDataPath, script)
}

function ensureShimForScript(userDataPath: string, script: string): string | null {
  const shimDir = join(userDataPath, SHIM_DIR_NAME)
  const shimPath = join(shimDir, 'orca')
  try {
    if (readShim(shimPath) !== script) {
      mkdirSync(shimDir, { recursive: true })
      writeFileSync(shimPath, script, 'utf8')
    }
    chmodSync(shimPath, 0o755)
  } catch {
    return null
  }
  return shimDir
}

function readShim(shimPath: string): string | null {
  try {
    return readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
}
