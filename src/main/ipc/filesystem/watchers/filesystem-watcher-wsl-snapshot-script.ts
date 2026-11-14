const POLL_INTERVAL_SECONDS = 2

function quoteSafeFindName(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Unsupported WSL watcher ignore name: ${name}`)
  }
  return `'${name}'`
}

function quoteSafeFindSuffix(suffix: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(suffix)) {
    throw new Error(`Unsupported WSL watcher ignore suffix: ${suffix}`)
  }
  return `'*${suffix}'`
}

function buildPruneExpression(
  ignoreDirs: readonly string[],
  ignoreDirSuffixes: readonly string[]
): string {
  const matchers = [
    ...ignoreDirs.map((name) => `-name ${quoteSafeFindName(name)}`),
    ...ignoreDirSuffixes.map((suffix) => `-name ${quoteSafeFindSuffix(suffix)}`)
  ]
  if (matchers.length === 0) {
    return ''
  }
  return `\\( -type d \\( ${matchers.join(' -o ')} \\) -prune \\) -o`
}

/** The in-distro poll loop: a snapshot frame bounded by the SNAPSHOT start/end markers (see caller). */
export function buildWslSnapshotScript(
  ignoreDirs: readonly string[],
  ignoreDirSuffixes: readonly string[]
): string {
  const prune = buildPruneExpression(ignoreDirs, ignoreDirSuffixes)
  // A staged *.asar file is as locking as its directory: never report one as a change (#40204).
  const suffixFilters = ignoreDirSuffixes.map((suffix) => `! -name ${quoteSafeFindSuffix(suffix)}`)
  const printFilter = suffixFilters.length
    ? `\\( ${suffixFilters.join(' -a ')} \\) -printf`
    : '-printf'
  return [
    'set -efu',
    'root=$1',
    'while :; do',
    "  printf '\\000\\036\\000'",
    '  if [ -d "$root" ]; then',
    `    find "$root" -mindepth 1 -maxdepth 2 ${prune} ${printFilter} '%y\\t%T@\\t%p\\0' 2>/dev/null || true`,
    '  fi',
    "  printf '\\000\\037\\000'",
    `  sleep ${POLL_INTERVAL_SECONDS} || exit 0`,
    'done'
  ].join('\n')
}
