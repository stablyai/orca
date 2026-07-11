import type { Event as WatcherEvent } from '@parcel/watcher'

const POLL_INTERVAL_SECONDS = 5
const SAFE_IGNORE_NAME = /^[A-Za-z0-9_.-]+$/
// NUL cannot occur in a Linux filename. An empty NUL record therefore closes
// a frame without reserving legal filename bytes as stream sentinels.
export const SNAPSHOT_START = ''
export const SNAPSHOT_END = '\0'
export const MAX_SNAPSHOT_RECORD_CHARS = 64 * 1024

export type WslSnapshotEntry = {
  path: string
  type: string
  mtime: string
}

export type WslSnapshot = Map<string, WslSnapshotEntry>

export function validateWslWatcherIgnoreDirs(ignoreDirs: readonly string[]): void {
  for (const name of ignoreDirs) {
    if (!SAFE_IGNORE_NAME.test(name)) {
      throw new Error(`Unsupported WSL watcher ignore name: ${name}`)
    }
  }
}

export function toWslUncPath(linuxPath: string, distro: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

function buildPruneExpression(ignoreDirs: readonly string[]): string {
  validateWslWatcherIgnoreDirs(ignoreDirs)
  if (ignoreDirs.length === 0) {
    return ''
  }
  const names = ignoreDirs.map((name) => `-name '${name}'`).join(' -o ')
  return `\\( -type d \\( ${names} \\) -prune \\) -o`
}

// Why: files can vanish after find batches them. Retry a failed batch one path
// at a time so churn is skipped; unreadable survivors are logged and skipped
// too, because a partial snapshot beats aborting the whole watcher.
const BUSYBOX_STAT_BATCH_SCRIPT =
  'tmp="${TMPDIR:-/tmp}/orca-wsl-snapshot-$$"; error="$tmp.error"; ' +
  'trap \'rm -f "$tmp" "$error"\' EXIT; ' +
  'if stat -c "%F\t%y" -- "$@" >"$tmp" 2>"$error"; then ' +
  'exec 3<"$tmp"; for path do IFS= read -r metadata <&3 || exit 75; ' +
  'printf "%s\\t%s\\0" "$metadata" "$path"; done; ' +
  'else for path do if metadata=$(stat -c "%F\t%y" -- "$path" 2>"$error"); then ' +
  'printf "%s\\t%s\\0" "$metadata" "$path"; ' +
  'elif test ! -e "$path" && test ! -L "$path"; then :; ' +
  'else cat "$error" >&2; fi; done; fi'

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

type SnapshotScriptOptions = {
  forcePortable?: boolean
  once?: boolean
}

export function buildSnapshotScript(
  ignoreDirs: readonly string[],
  options: SnapshotScriptOptions = {}
): string {
  const prune = buildPruneExpression(ignoreDirs)
  const findMode = options.forcePortable
    ? 'snapshot_find=portable'
    : 'if find "$root" -printf "" -quit >/dev/null 2>&1; then snapshot_find=gnu; else snapshot_find=portable; fi'
  const repeat = options.once ? '  exit 0' : `  sleep ${POLL_INTERVAL_SECONDS} || exit 0`
  return [
    'set -efu',
    'root=$1',
    'command -v find >/dev/null',
    'command -v stat >/dev/null',
    'stat -c "%F\t%y" -- "$root" >/dev/null',
    findMode,
    'while :; do',
    '  if [ -d "$root" ]; then',
    // Why: GNU find is the zero-fork fast path. BusyBox batches paths through
    // one stat process per ARG_MAX group while retaining NUL-safe filenames.
    // Why: `|| true` — an unreadable subtree or mid-scan churn must degrade to
    // a partial snapshot, not abort the engine and orphan the whole worktree.
    `    if [ "$snapshot_find" = gnu ]; then find "$root" -mindepth 1 ${prune} -printf '%y\\t%T@\\t%p\\0' || true;`,
    `    else find "$root" -mindepth 1 ${prune} -exec sh -c ${quoteShellArgument(BUSYBOX_STAT_BATCH_SCRIPT)} sh {} + || true; fi`,
    '  fi',
    "  printf '\\0'",
    repeat,
    'done'
  ].join('\n')
}

export function parseSnapshotRecord(
  rawEntry: string,
  distro: string
): [path: string, entry: WslSnapshotEntry] | null {
  if (!rawEntry || rawEntry.length > MAX_SNAPSHOT_RECORD_CHARS) {
    return null
  }
  const firstTab = rawEntry.indexOf('\t')
  const secondTab = firstTab === -1 ? -1 : rawEntry.indexOf('\t', firstTab + 1)
  if (firstTab <= 0 || secondTab <= firstTab + 1) {
    return null
  }
  const linuxPath = rawEntry.slice(secondTab + 1)
  if (!linuxPath.startsWith('/')) {
    return null
  }
  const entry: WslSnapshotEntry = {
    type: rawEntry.slice(0, firstTab),
    mtime: rawEntry.slice(firstTab + 1, secondTab),
    path: toWslUncPath(linuxPath, distro)
  }
  return [entry.path, entry]
}

export function parseSnapshotFrame(frame: string, distro: string): WslSnapshot {
  const snapshot: WslSnapshot = new Map()
  for (const rawEntry of frame.split('\0')) {
    const parsed = parseSnapshotRecord(rawEntry, distro)
    if (parsed) {
      snapshot.set(...parsed)
    }
  }
  return snapshot
}

export function diffSnapshots(prev: WslSnapshot, next: WslSnapshot): WatcherEvent[] {
  const events: WatcherEvent[] = []
  for (const [entryPath, nextEntry] of next) {
    const prevEntry = prev.get(entryPath)
    if (!prevEntry) {
      events.push({ type: 'create', path: entryPath } as WatcherEvent)
    } else if (prevEntry.type !== nextEntry.type) {
      events.push({ type: 'delete', path: entryPath } as WatcherEvent)
      events.push({ type: 'create', path: entryPath } as WatcherEvent)
    } else if (prevEntry.mtime !== nextEntry.mtime) {
      events.push({ type: 'update', path: entryPath } as WatcherEvent)
    }
  }
  for (const entryPath of prev.keys()) {
    if (!next.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath } as WatcherEvent)
    }
  }
  return events
}
