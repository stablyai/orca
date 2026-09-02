/**
 * The remote shell for the shared native-deps cache (`ssh-relay-native-deps-cache.ts`).
 *
 * Every script here is POSIX `sh` and answers with one token, because the only alternative to a
 * token is inferring success from an exit status the transport can also produce. A command that
 * cannot answer is a cache miss, never a licence to delete: `MISS` and `NOT_PROMOTED` both leave
 * the relay directory owning its own `node_modules`, which is exactly today's behaviour.
 */
import { shellEscape } from './ssh-connection-utils'
import {
  RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME,
  RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX,
  relayNativeDepsCacheBaseDir,
  relayNativeDepsCacheEntryDir,
  relayNativeDepsCacheNodeModulesPath,
  remoteInstallRootDir
} from './ssh-relay-native-deps-cache'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export const RELAY_NATIVE_CACHE_LINKED = '__ORCA_NATIVE_CACHE__LINKED'
export const RELAY_NATIVE_CACHE_SEEDED = '__ORCA_NATIVE_CACHE__SEEDED'
export const RELAY_NATIVE_CACHE_MISS = '__ORCA_NATIVE_CACHE__MISS'
export const RELAY_NATIVE_CACHE_PROMOTED = '__ORCA_NATIVE_CACHE__PROMOTED'
export const RELAY_NATIVE_CACHE_NOT_PROMOTED = '__ORCA_NATIVE_CACHE__NOT_PROMOTED'
export const RELAY_NATIVE_CACHE_LIST_OK = '__ORCA_NATIVE_CACHE__LIST_OK'
export const RELAY_NATIVE_CACHE_REFS_OK = '__ORCA_NATIVE_CACHE__REFS_OK'
export const RELAY_NATIVE_CACHE_REFS_ERR = '__ORCA_NATIVE_CACHE__REFS_ERR'

/**
 * How old an entry without `.deps-complete` must be before another deploy may reclaim it. Well
 * past the 15-minute deploy ceiling, so a live installer is never mistaken for a crashed one.
 * Reclaiming is safe at any age in principle — nothing links an entry until it is complete — but
 * the margin is what keeps that argument from resting on a single `[ -f ]`.
 */
const CACHE_TAKEOVER_MINUTES = 120

/** A crashed GC pass leaves a tombstone; it drains once no in-flight pass could still own it. */
const CACHE_TOMBSTONE_SWEEP_MINUTES = 30

/** Bounds every listing, matching `MAX_RELAY_GC_LISTING_ENTRIES`' role for version dirs. */
export const MAX_RELAY_NATIVE_CACHE_LISTING_ENTRIES = 64

export type RelayNativeDepsCachePaths = {
  host: RemoteHostPlatform
  remoteHome: string
  relayDir: string
  key: string
}

function cachePaths(paths: RelayNativeDepsCachePaths): {
  base: string
  entry: string
  target: string
  nodeModules: string
  root: string
} {
  const { host, remoteHome, relayDir, key } = paths
  return {
    base: relayNativeDepsCacheBaseDir(host, remoteHome),
    entry: relayNativeDepsCacheEntryDir(host, remoteHome, key),
    target: relayNativeDepsCacheNodeModulesPath(host, remoteHome, key),
    nodeModules: joinRemotePath(host, relayDir, 'node_modules'),
    root: remoteInstallRootDir(host, remoteHome)
  }
}

/**
 * Link a complete entry into the relay directory, or seed a private tree from a sibling relay
 * directory that already has a matching one.
 *
 * The seed exists so the first deploy after this ships does not recompile once more on a host
 * that already paid for the compile. It is not trusted: the copy is a plain private install until
 * the normal probe loads both addons, and only then is it promoted.
 */
export function ensureRelayNativeDepsCacheCommand(
  paths: RelayNativeDepsCachePaths,
  deps: Readonly<Record<string, string>>
): string {
  const { entry, target, nodeModules, root } = cachePaths(paths)
  // Why grep the sibling's manifest: an older Orca pinned different versions, and a
  // toolchain-skip host wrote one with node-pty removed. Both must fail to qualify.
  const depGuards = Object.entries(deps).map(
    ([name, version]) => `grep -F -q ${shellEscape(`"${name}":"${version}"`)} "$pj" || continue`
  )
  return [
    `cache=${shellEscape(entry)}`,
    `target=${shellEscape(target)}`,
    `nm=${shellEscape(nodeModules)}`,
    `root=${shellEscape(root)}`,
    `if [ -f "$cache/${RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME}" ] && [ -d "$target" ]; then`,
    '  if [ -L "$nm" ]; then',
    `    if [ "$(readlink "$nm" 2>/dev/null)" = "$target" ]; then printf '%s\\n' ${RELAY_NATIVE_CACHE_LINKED}; exit 0; fi`,
    '    rm -f "$nm" 2>/dev/null || true',
    '  fi',
    `  if [ ! -e "$nm" ] && ln -s "$target" "$nm" 2>/dev/null; then printf '%s\\n' ${RELAY_NATIVE_CACHE_LINKED}; exit 0; fi`,
    `  printf '%s\\n' ${RELAY_NATIVE_CACHE_MISS}; exit 0`,
    'fi',
    'if [ ! -e "$nm" ] && [ ! -L "$nm" ]; then',
    '  for cand in "$root"/relay-*/node_modules; do',
    '    [ -d "$cand" ] || continue',
    '    [ -L "$cand" ] && continue',
    '    [ -d "$cand/node-pty" ] || continue',
    '    [ -d "$cand/@parcel/watcher" ] || continue',
    '    pj="${cand%/node_modules}/package.json"',
    '    [ -f "$pj" ] || continue',
    ...depGuards.map((guard) => `    ${guard}`),
    '    seed="$nm.seed.$$"',
    '    rm -rf "$seed" 2>/dev/null || true',
    '    if cp -Rp "$cand" "$seed" 2>/dev/null && mv "$seed" "$nm" 2>/dev/null; then',
    `      printf '%s\\n' ${RELAY_NATIVE_CACHE_SEEDED}; exit 0`,
    '    fi',
    '    rm -rf "$seed" 2>/dev/null || true',
    '    break',
    '  done',
    'fi',
    `printf '%s\\n' ${RELAY_NATIVE_CACHE_MISS}`
  ].join('\n')
}

/**
 * Publish a probe-verified private tree as the shared entry, then link the relay directory to it.
 *
 * `mkdir "$cache"` is the election: exactly one deploy creates the directory, and a loser keeps
 * its own tree rather than writing into someone else's. `.deps-complete` is written last, after
 * the symlink exists, so an entry is never linkable before it is referenced.
 */
export function promoteRelayNativeDepsCacheCommand(paths: RelayNativeDepsCachePaths): string {
  const { base, entry, target, nodeModules } = cachePaths(paths)
  const notPromoted = `printf '%s\\n' ${RELAY_NATIVE_CACHE_NOT_PROMOTED}`
  return [
    `base=${shellEscape(base)}`,
    `cache=${shellEscape(entry)}`,
    `target=${shellEscape(target)}`,
    `nm=${shellEscape(nodeModules)}`,
    `[ -d "$nm" ] || { ${notPromoted}; exit 0; }`,
    `if [ -L "$nm" ]; then ${notPromoted}; exit 0; fi`,
    `mkdir -p "$base" 2>/dev/null || { ${notPromoted}; exit 0; }`,
    `if [ -d "$cache" ] && [ ! -f "$cache/${RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME}" ]; then`,
    `  if [ -n "$(find "$cache" -maxdepth 0 -mmin +${CACHE_TAKEOVER_MINUTES} 2>/dev/null)" ]; then`,
    '    rm -rf "$cache" 2>/dev/null || true',
    '  fi',
    'fi',
    `mkdir "$cache" 2>/dev/null || { ${notPromoted}; exit 0; }`,
    'if mv "$nm" "$target" 2>/dev/null; then',
    '  if ln -s "$target" "$nm" 2>/dev/null; then',
    `    : > "$cache/${RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME}" 2>/dev/null || true`,
    `    if [ -f "$cache/${RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME}" ]; then printf '%s\\n' ${RELAY_NATIVE_CACHE_PROMOTED}; exit 0; fi`,
    '  fi',
    '  rm -f "$nm" 2>/dev/null || true',
    // Why the rm is conditional on the move back: a failed restore leaves the only copy of the
    // tree inside an incomplete entry. Deleting it there would cost the relay its native deps.
    '  if mv "$target" "$nm" 2>/dev/null; then rm -rf "$cache" 2>/dev/null || true; fi',
    `  ${notPromoted}; exit 0`,
    'fi',
    'rm -rf "$cache" 2>/dev/null || true',
    notPromoted
  ].join('\n')
}

/** Complete entries only; an incomplete one belongs to an installer, not to GC. */
export function listRelayNativeDepsCacheEntriesCommand(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  const base = relayNativeDepsCacheBaseDir(host, remoteHome)
  return [
    `base=${shellEscape(base)}`,
    `[ -d "$base" ] || { printf '%s\\n' ${RELAY_NATIVE_CACHE_LIST_OK}; exit 0; }`,
    `find "$base" -maxdepth 1 -name ${shellEscape(`${RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX}*`)} -mmin +${CACHE_TOMBSTONE_SWEEP_MINUTES} -exec rm -rf {} + 2>/dev/null || true`,
    'n=0',
    'for d in "$base"/*/; do',
    '  [ -d "$d" ] || continue',
    `  [ -f "$d${RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME}" ] || continue`,
    '  name=${d%/}',
    '  name=${name##*/}',
    `  printf 'ENTRY %s\\n' "$name"`,
    '  n=$((n+1))',
    `  if [ "$n" -ge ${MAX_RELAY_NATIVE_CACHE_LISTING_ENTRIES} ]; then break; fi`,
    'done',
    `printf '%s\\n' ${RELAY_NATIVE_CACHE_LIST_OK}`
  ].join('\n')
}

/**
 * Every symlinked `node_modules` under `~/.orca-remote/`, as its raw target.
 *
 * The scan is deliberately wider than `relay-*`: a directory this client does not recognise still
 * counts as a referrer. An unreadable link or an overrun listing answers `REFS_ERR`, which stops
 * the whole pass — an incomplete reference list is not evidence that anything is unreferenced.
 */
export function listRelayNativeDepsCacheReferencesCommand(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  const root = remoteInstallRootDir(host, remoteHome)
  return [
    `root=${shellEscape(root)}`,
    `[ -d "$root" ] || { printf '%s\\n' ${RELAY_NATIVE_CACHE_REFS_OK}; exit 0; }`,
    'n=0',
    'for d in "$root"/*/node_modules; do',
    '  [ -L "$d" ] || continue',
    '  t=$(readlink "$d" 2>/dev/null) || t=""',
    `  if [ -z "$t" ]; then printf '%s\\n' ${RELAY_NATIVE_CACHE_REFS_ERR}; exit 0; fi`,
    `  printf 'REF %s\\n' "$t"`,
    '  n=$((n+1))',
    `  if [ "$n" -ge ${MAX_RELAY_NATIVE_CACHE_LISTING_ENTRIES} ]; then printf '%s\\n' ${RELAY_NATIVE_CACHE_REFS_ERR}; exit 0; fi`,
    'done',
    `printf '%s\\n' ${RELAY_NATIVE_CACHE_REFS_OK}`
  ].join('\n')
}
