/**
 * The `sh` program the WSL watcher pipes into the distro: it polls the worktree
 * with `find` and streams one framed snapshot per interval.
 */
const POLL_INTERVAL_SECONDS = 2
// Why: a recursive scan of a huge tree costs more per poll than the freshness it
// buys, so back the in-distro loop off instead of capping depth (which blinds it).
const SLOW_POLL_INTERVAL_SECONDS = 10
const LARGE_SNAPSHOT_BYTES = 2_000_000

function quoteSafeFindName(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Unsupported WSL watcher ignore name: ${name}`)
  }
  return `'${name}'`
}

function buildPruneExpression(ignoreDirs: readonly string[]): string {
  if (ignoreDirs.length === 0) {
    return ''
  }
  const names = ignoreDirs.map((name) => `-name ${quoteSafeFindName(name)}`).join(' -o ')
  return `\\( -type d \\( ${names} \\) -prune \\) -o`
}

export function buildSnapshotScript(ignoreDirs: readonly string[]): string {
  const prune = buildPruneExpression(ignoreDirs)
  return [
    'set -efu',
    'root=$1',
    // Why: BusyBox/Alpine find has no -printf; without this probe every frame is
    // silently empty and the watcher looks healthy while seeing nothing.
    "find / -maxdepth 0 -printf '' 2>/dev/null || { printf 'orca-watcher-unsupported-find\\n' >&2; exit 3; }",
    'snapshot=$(mktemp) || exit 4',
    `trap 'rm -f "$snapshot"' EXIT`,
    `trap 'rm -f "$snapshot"; exit 0' INT TERM`,
    `interval=${POLL_INTERVAL_SECONDS}`,
    'while :; do',
    '  : > "$snapshot"',
    '  if [ -d "$root" ]; then',
    // The prune expression drops .git/node_modules/etc at every depth, so full
    // recursion here matches what @parcel/watcher reports on native platforms.
    `    find "$root" -mindepth 1 ${prune} -printf '%y\\t%T@\\t%p\\0' > "$snapshot" 2>/dev/null || true`,
    '  fi',
    "  printf '\\036'",
    '  cat "$snapshot"',
    "  printf '\\037'",
    '  size=$(wc -c < "$snapshot" 2>/dev/null || echo 0)',
    `  if [ "\${size:-0}" -gt ${LARGE_SNAPSHOT_BYTES} ]; then interval=${SLOW_POLL_INTERVAL_SECONDS}; else interval=${POLL_INTERVAL_SECONDS}; fi`,
    '  sleep "$interval" || exit 0',
    'done'
  ].join('\n')
}
