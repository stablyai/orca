import { posix as pathPosix } from 'node:path'
import { quotePosixShell as quoteBashString } from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/wsl-runner'

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

  const result = await runWslProcess({
    distro: target.distro,
    lane: 'probe',
    script: buildWslCodexSessionBridgeShellCommand(paths),
    // Process substitution and `read -d` are bash-only; dash rejects both.
    shell: 'bash',
    timeoutMs: WSL_SESSION_BRIDGE_TIMEOUT_MS
  })
  if (result.code !== 0 || result.timedOut) {
    throw Object.assign(
      new Error(`WSL codex session bridge failed for ${target.distro} (code ${result.code})`),
      { code: result.code, stderr: result.stderr, timedOut: result.timedOut }
    )
  }
  return parseWslSessionBridgeSummary(result.stdout)
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
    // Linux hardlinks created inside the distro filesystem.
    '  if ln -- "$source_file" "$target_file"; then',
    '    linked_files=$((linked_files + 1))',
    '  fi',
    `done < <(find "$source_sessions_root" -type f -name '*.jsonl' -print0 2>/dev/null)`,
    `printf '{"scannedFiles":%s,"linkedFiles":%s}\\n' "$scanned_files" "$linked_files"`
  ].join('\n')
  return shellCommand
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
