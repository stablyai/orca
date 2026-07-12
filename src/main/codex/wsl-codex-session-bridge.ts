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
    'json_escape() {',
    '  local value="$1"',
    '  value=${value//\\\\/\\\\\\\\}',
    '  value=${value//\\"/\\\\\\"}',
    "  value=${value//$'\\n'/\\\\n}",
    "  value=${value//$'\\r'/\\\\r}",
    "  value=${value//$'\\t'/\\\\t}",
    '  printf \'%s\' "$value"',
    '}',
    'file_sha256() {',
    '  local output hash',
    '  output=$(sha256sum -- "$1" 2>/dev/null) || return 1',
    '  hash=${output%% *}',
    '  [ "${#hash}" -eq 64 ] || return 1',
    '  printf \'%s\' "$hash"',
    '}',
    // Why: sourceSize records the verified copied prefix, not the source's
    // current full size, because an active rollout may still be growing.
    'write_copy_marker() {',
    '  local marker_file="$1" source_file="$2" target_file="$3"',
    '  mkdir -p -- "$(dirname -- "$marker_file")" 2>/dev/null || return 1',
    '  local source_size target_size source_mtime_ms target_mtime_ms source_path_json target_fingerprint',
    '  target_size=$(stat -c %s -- "$target_file" 2>/dev/null) || return 1',
    '  source_size=$(stat -c %s -- "$source_file" 2>/dev/null) || return 1',
    '  [ "$target_size" -le "$source_size" ] || return 1',
    '  cmp --silent --bytes="$target_size" -- "$target_file" "$source_file" || return 1',
    '  source_size=$target_size',
    '  source_mtime_ms=$(($(stat -c %Y -- "$source_file" 2>/dev/null) * 1000)) || return 1',
    '  target_mtime_ms=$(($(stat -c %Y -- "$target_file" 2>/dev/null) * 1000)) || return 1',
    '  source_path_json=$(json_escape "$source_file") || return 1',
    '  target_fingerprint=$(file_sha256 "$target_file") || return 1',
    `  printf '{"version":2,"mtimePrecision":"seconds","sourcePath":"%s","sourceSize":%s,"sourceMtimeMs":%s,"targetSize":%s,"targetMtimeMs":%s,"targetFingerprintSha256":"%s"}\\n' "$source_path_json" "$source_size" "$source_mtime_ms" "$target_size" "$target_mtime_ms" "$target_fingerprint" >"$marker_file" 2>/dev/null`,
    '}',
    'copy_marker_matches() {',
    '  local marker_file="$1" source_file="$2" target_file="$3"',
    '  local marker_content source_path_json target_size target_mtime_ms target_fingerprint marker_prefix marker_suffix stored_source_mtime',
    '  [ -f "$marker_file" ] || return 1',
    '  marker_content=$(<"$marker_file") || return 1',
    '  source_path_json=$(json_escape "$source_file") || return 1',
    '  target_size=$(stat -c %s -- "$target_file" 2>/dev/null) || return 1',
    '  target_mtime_ms=$(($(stat -c %Y -- "$target_file" 2>/dev/null) * 1000)) || return 1',
    '  target_fingerprint=$(file_sha256 "$target_file") || return 1',
    `  marker_prefix=$(printf '{"version":2,"mtimePrecision":"seconds","sourcePath":"%s","sourceSize":%s,"sourceMtimeMs":' "$source_path_json" "$target_size")`,
    `  marker_suffix=$(printf ',"targetSize":%s,"targetMtimeMs":%s,"targetFingerprintSha256":"%s"}' "$target_size" "$target_mtime_ms" "$target_fingerprint")`,
    '  stored_source_mtime=${marker_content#"$marker_prefix"}',
    '  stored_source_mtime=${stored_source_mtime%"$marker_suffix"}',
    '  [ "$marker_content" = "${marker_prefix}${stored_source_mtime}${marker_suffix}" ] || return 1',
    '  case "$stored_source_mtime" in ""|*[!0-9]*) return 1 ;; esac',
    '}',
    'write_preserved_record() {',
    '  local record_file="$1" source_file="$2" target_file="$3" preserved_file="$4" displaced_file="$5"',
    '  local source_json target_json preserved_json displaced_json preserved_fingerprint',
    '  source_json=$(json_escape "$source_file") || return 1',
    '  target_json=$(json_escape "$target_file") || return 1',
    '  preserved_json=$(json_escape "$preserved_file") || return 1',
    '  displaced_json=$(json_escape "$displaced_file") || return 1',
    '  preserved_fingerprint=$(file_sha256 "$preserved_file") || return 1',
    `  ( set -o noclobber; printf '{"version":1,"sourcePath":"%s","originalTargetPath":"%s","preservedPath":"%s","displacedTargetPath":"%s","preservedFingerprintSha256":"%s"}\\n' "$source_json" "$target_json" "$preserved_json" "$displaced_json" "$preserved_fingerprint" >"$record_file" ) 2>/dev/null`,
    '}',
    // Why: preserve the pre-refresh inode so open file descriptors stay observable;
    // once that evidence exists, halt automatic refresh until human review.
    'refresh_copy() {',
    '  local marker_file="$1" source_file="$2" target_file="$3" relative_path="$4"',
    '  local target_size source_size target_size_after target_fingerprint_before target_fingerprint_after',
    '  local replacement_file preserved_file preserved_record displaced_file preserved_size preserved_fingerprint',
    '  preserved_file="$managed_sessions_root/../.orca-session-preserved/${relative_path}.orca-preserved"',
    '  preserved_record="$managed_sessions_root/../.orca-session-preserved/${relative_path}.json"',
    '  displaced_file="${preserved_file}.displaced-$$"',
    '  if [ -e "$preserved_file" ] || [ -e "$preserved_record" ] || [ -e "$displaced_file" ]; then',
    '    printf \'%s\\n\' "[codex-session-bridge] Automatic refresh stopped; preserved copy requires review: $preserved_file" >&2',
    '    return 1',
    '  fi',
    '  copy_marker_matches "$marker_file" "$source_file" "$target_file" || return 1',
    '  target_size=$(stat -c %s -- "$target_file" 2>/dev/null) || return 1',
    '  source_size=$(stat -c %s -- "$source_file" 2>/dev/null) || return 1',
    '  [ "$target_size" -lt "$source_size" ] || return 1',
    '  target_fingerprint_before=$(file_sha256 "$target_file") || return 1',
    '  cmp --silent --bytes="$target_size" -- "$target_file" "$source_file" || return 1',
    '  replacement_file="${target_file}.orca-copy-$$"',
    '  if ! cp -p -- "$source_file" "$replacement_file"; then',
    '    rm -f -- "$replacement_file"',
    '    return 1',
    '  fi',
    '  target_size_after=$(stat -c %s -- "$target_file" 2>/dev/null) || { rm -f -- "$replacement_file"; return 1; }',
    '  target_fingerprint_after=$(file_sha256 "$target_file") || { rm -f -- "$replacement_file"; return 1; }',
    '  if [ "$target_size_after" != "$target_size" ] || [ "$target_fingerprint_after" != "$target_fingerprint_before" ] || ! cmp --silent --bytes="$target_size" -- "$target_file" "$source_file"; then',
    '    rm -f -- "$replacement_file"',
    '    return 1',
    '  fi',
    '  mkdir -p -- "$(dirname -- "$preserved_file")" || { rm -f -- "$replacement_file"; return 1; }',
    '  if ! ln -- "$target_file" "$preserved_file"; then',
    '    rm -f -- "$replacement_file"',
    '    return 1',
    '  fi',
    '  if ! write_preserved_record "$preserved_record" "$source_file" "$target_file" "$preserved_file" "$displaced_file"; then',
    '    rm -f -- "$replacement_file"',
    '    printf \'%s\\n\' "[codex-session-bridge] Preserved copy has no sidecar record: $preserved_file" >&2',
    '    return 1',
    '  fi',
    '  preserved_size=$(stat -c %s -- "$preserved_file" 2>/dev/null || printf 0)',
    '  preserved_fingerprint=$(file_sha256 "$preserved_file" 2>/dev/null || printf invalid)',
    '  if [ "$preserved_size" != "$target_size" ] || [ "$preserved_fingerprint" != "$target_fingerprint_before" ]; then',
    '    rm -f -- "$replacement_file"',
    '    return 1',
    '  fi',
    '  if ! mv -- "$target_file" "$displaced_file"; then',
    '    rm -f -- "$replacement_file"',
    '    return 1',
    '  fi',
    '  if ! ln -- "$replacement_file" "$target_file"; then',
    '    rm -f -- "$replacement_file"',
    '    ln -- "$displaced_file" "$target_file" 2>/dev/null || true',
    '    return 1',
    '  fi',
    '  rm -f -- "$replacement_file"',
    '  if ! write_copy_marker "$marker_file" "$source_file" "$target_file"; then',
    '    printf \'%s\\n\' "[codex-session-bridge] Installed preserved bridge without marker update: $target_file" >&2',
    '  fi',
    '}',
    'if [ ! -d "$source_sessions_root" ]; then',
    `  printf '{"scannedFiles":0,"linkedFiles":0}\\n'`,
    '  exit 0',
    'fi',
    "while IFS= read -r -d '' source_file; do",
    '  scanned_files=$((scanned_files + 1))',
    '  relative_path=${source_file#"$source_sessions_root"/}',
    '  target_file="$managed_sessions_root/$relative_path"',
    '  marker_file="$managed_sessions_root/../.orca-session-copies/${relative_path}.json"',
    '  if [ -L "$target_file" ]; then',
    '    continue',
    '  fi',
    '  if [ -e "$target_file" ]; then',
    '    if refresh_copy "$marker_file" "$source_file" "$target_file" "$relative_path"; then',
    '      linked_files=$((linked_files + 1))',
    '    fi',
    '    continue',
    '  fi',
    '  target_dir=${target_file%/*}',
    '  mkdir -p -- "$target_dir" || continue',
    // Why: Codex resume ignores symlinks; cross-filesystem hardlink failure
    // falls back to a marked regular-file copy.
    '  if ln -- "$source_file" "$target_file"; then',
    '    rm -f -- "$marker_file"',
    '    linked_files=$((linked_files + 1))',
    '  else',
    '    replacement_file="${target_file}.orca-copy-$$"',
    '    if cp -p -- "$source_file" "$replacement_file" && ln -- "$replacement_file" "$target_file"; then',
    '      rm -f -- "$replacement_file"',
    '      if ! write_copy_marker "$marker_file" "$source_file" "$target_file"; then',
    '        printf \'%s\\n\' "[codex-session-bridge] Installed unmarked exclusive copy: $target_file" >&2',
    '      fi',
    '      linked_files=$((linked_files + 1))',
    '    else',
    '      rm -f -- "$replacement_file"',
    '    fi',
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
