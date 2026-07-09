import { execFile } from 'node:child_process'
import { posix as pathPosix } from 'node:path'
import { escapeWslShCommandForWindows } from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'

export type WslCodexSessionBridgeTarget = {
  distro: string
  systemCodexHomePath: string
  managedCodexHomePath: string
}

export type WslCodexSessionBridgeLinuxPaths = {
  systemSessionsRoot: string
  managedSessionsRoot: string
}

export type WslCodexSessionBridgeSummary = {
  scannedFiles: number
  linkedFiles: number
}

const emptySummary: WslCodexSessionBridgeSummary = { scannedFiles: 0, linkedFiles: 0 }
const backgroundWslSessionBridgeTasks = new Map<string, Promise<void>>()
const WSL_SESSION_BRIDGE_TIMEOUT_MS = 30_000

export function startWslCodexSessionBridgeInBackground(
  target: WslCodexSessionBridgeTarget
): Promise<void> {
  const taskKey = getWslSessionBridgeTaskKey(target)
  const existingTask = backgroundWslSessionBridgeTasks.get(taskKey)
  if (existingTask) {
    return existingTask
  }

  const task = syncWslCodexSessionsIntoManagedHome(target)
    .catch((error: unknown) => {
      console.warn('[codex-session-bridge] Background WSL session bridge failed:', error)
    })
    .then(() => undefined)
  backgroundWslSessionBridgeTasks.set(taskKey, task)
  void task.finally(() => {
    if (backgroundWslSessionBridgeTasks.get(taskKey) === task) {
      backgroundWslSessionBridgeTasks.delete(taskKey)
    }
  })
  return task
}

export async function syncWslCodexSessionsIntoManagedHome(
  target: WslCodexSessionBridgeTarget
): Promise<WslCodexSessionBridgeSummary> {
  const paths = resolveWslCodexSessionBridgeLinuxPaths(target)
  if (!paths) {
    return emptySummary
  }

  const stdout = await execFileUtf8('wsl.exe', [
    '-d',
    target.distro,
    '--',
    'bash',
    '-lc',
    buildWslCodexSessionBridgeShellCommand(paths)
  ])
  return parseWslSessionBridgeSummary(stdout)
}

export function resolveWslCodexSessionBridgeLinuxPaths(
  target: WslCodexSessionBridgeTarget
): WslCodexSessionBridgeLinuxPaths | null {
  const systemHomePath = getLinuxPathForWslDistro(target.systemCodexHomePath, target.distro)
  const managedHomePath = getLinuxPathForWslDistro(target.managedCodexHomePath, target.distro)
  if (!systemHomePath || !managedHomePath) {
    return null
  }

  return {
    systemSessionsRoot: joinLinuxPath(systemHomePath, 'sessions'),
    managedSessionsRoot: joinLinuxPath(managedHomePath, 'sessions')
  }
}

export function buildWslCodexSessionBridgeShellCommand(
  paths: WslCodexSessionBridgeLinuxPaths
): string {
  const shellCommand = [
    'set -u',
    `source_sessions_root=${quoteBashString(paths.systemSessionsRoot)}`,
    `managed_sessions_root=${quoteBashString(paths.managedSessionsRoot)}`,
    'scanned_files=0',
    'linked_files=0',
    'if [ ! -d "$source_sessions_root" ]; then',
    `  printf '{"scannedFiles":0,"linkedFiles":0}\\n'`,
    '  exit 0',
    'fi',
    "while IFS= read -r -d '' source_file; do",
    '  scanned_files=$((scanned_files + 1))',
    '  relative_path=${source_file#"$source_sessions_root"/}',
    '  target_file="$managed_sessions_root/$relative_path"',
    '  if [ -e "$target_file" ] || [ -L "$target_file" ]; then',
    '    continue',
    '  fi',
    '  target_dir=${target_file%/*}',
    '  mkdir -p -- "$target_dir" || continue',
    // Why: Codex resume ignores symlinked JSONL, so WSL links must be
    // Linux hardlinks created inside the distro filesystem. Cross-filesystem
    // hardlink failure falls back to cp -p (regular file), never symlink.
    '  if ln -- "$source_file" "$target_file"; then',
    '    linked_files=$((linked_files + 1))',
    '  elif cp -p -- "$source_file" "$target_file"; then',
    '    linked_files=$((linked_files + 1))',
    // Why: hardlinks share an inode so usage de-dupes automatically; cp creates
    // a second file the scanner would count twice unless we leave the same
    // .orca-session-copies marker the Windows bridge writes after copyFileSync.
    '    marker_file="$managed_sessions_root/../.orca-session-copies/${relative_path}.json"',
    '    mkdir -p -- "$(dirname -- "$marker_file")" 2>/dev/null || true',
    '    source_size=$(stat -c %s -- "$source_file" 2>/dev/null || printf 0)',
    '    target_size=$(stat -c %s -- "$target_file" 2>/dev/null || printf 0)',
    '    source_mtime_ms=$(($(stat -c %Y -- "$source_file" 2>/dev/null || printf 0) * 1000))',
    '    target_mtime_ms=$(($(stat -c %Y -- "$target_file" 2>/dev/null || printf 0) * 1000))',
    `    printf '{"sourcePath":"%s","sourceSize":%s,"sourceMtimeMs":%s,"targetSize":%s,"targetMtimeMs":%s}\\n' "$source_file" "$source_size" "$source_mtime_ms" "$target_size" "$target_mtime_ms" >"$marker_file" 2>/dev/null || true`,
    '  fi',
    `done < <(find "$source_sessions_root" -type f \\( -name '*.jsonl' -o -name '*.jsonl.zst' \\) -print0 2>/dev/null)`,
    `printf '{"scannedFiles":%s,"linkedFiles":%s}\\n' "$scanned_files" "$linked_files"`
  ].join('\n')
  return escapeWslShCommandForWindows(shellCommand)
}

function getWslSessionBridgeTaskKey(target: WslCodexSessionBridgeTarget): string {
  return [target.distro, target.systemCodexHomePath, target.managedCodexHomePath].join('\0')
}

function getLinuxPathForWslDistro(path: string, distro: string): string | null {
  const wslPath = parseWslUncPath(path)
  if (wslPath) {
    return wslDistroNamesMatch(wslPath.distro, distro) ? wslPath.linuxPath : null
  }
  return path.startsWith('/') ? path : null
}

function wslDistroNamesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function joinLinuxPath(basePath: string, ...segments: string[]): string {
  return pathPosix.join(basePath, ...segments)
}

function quoteBashString(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function execFileUtf8(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: WSL_SESSION_BRIDGE_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
}

function parseWslSessionBridgeSummary(stdout: string): WslCodexSessionBridgeSummary {
  try {
    // Why: login/profile scripts may write stdout before the bridge summary.
    const summaryLine =
      stdout
        .split(/\r?\n/)
        .findLast((line) => line.trim().length > 0)
        ?.trim() ?? ''
    const parsed: unknown = JSON.parse(summaryLine)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptySummary
    }
    const summary = parsed as Record<string, unknown>
    if (typeof summary.scannedFiles !== 'number' || typeof summary.linkedFiles !== 'number') {
      return emptySummary
    }
    return {
      scannedFiles: summary.scannedFiles,
      linkedFiles: summary.linkedFiles
    }
  } catch {
    return emptySummary
  }
}
