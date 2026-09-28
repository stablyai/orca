/** Historical cache scans require complete reference evidence before removal. */
import { shellEscape } from './ssh-connection-utils'
import {
  RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME,
  RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX,
  LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX,
  relayNativeDepsCacheBaseDir,
  remoteInstallRootDir
} from './ssh-relay-native-deps-cache'
import type { RemoteHostPlatform } from './ssh-remote-platform'

export const RELAY_NATIVE_CACHE_LIST_OK = '__ORCA_NATIVE_CACHE__LIST_OK'
export const RELAY_NATIVE_CACHE_REFS_OK = '__ORCA_NATIVE_CACHE__REFS_OK'
export const RELAY_NATIVE_CACHE_REFS_ERR = '__ORCA_NATIVE_CACHE__REFS_ERR'
export const MAX_RELAY_NATIVE_CACHE_LISTING_ENTRIES = 64

/** Complete entries and tombstones; deletion requires a separate reference scan. */
export function listRelayNativeDepsCacheEntriesCommand(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  const base = relayNativeDepsCacheBaseDir(host, remoteHome)
  return [
    `base=${shellEscape(base)}`,
    `[ -d "$base" ] || { printf '%s\\n' ${RELAY_NATIVE_CACHE_LIST_OK}; exit 0; }`,
    'n=0',
    `for d in "$base"/*/ "$base"/${RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX}*/ "$base"/${LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX}*/; do`,
    '  [ -d "$d" ] || continue',
    '  name=${d%/}',
    '  name=${name##*/}',
    `  case "$name" in ${RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX}*|${LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX}*) ;; *) [ -f "$d${RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME}" ] || continue ;; esac`,
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
    `[ -r "$root" ] && [ -x "$root" ] && ls -A "$root" >/dev/null 2>&1 || { printf '%s\\n' ${RELAY_NATIVE_CACHE_REFS_ERR}; exit 0; }`,
    'n=0',
    'for d in "$root"/*/; do',
    '  [ -d "$d" ] || continue',
    `  [ -r "$d" ] && [ -x "$d" ] || { printf '%s\\n' ${RELAY_NATIVE_CACHE_REFS_ERR}; exit 0; }`,
    '  d="${d}node_modules"',
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

/** A missing completion marker means deletion began; leave that tree for later cleanup. */
export function restoreRelayNativeDepsCacheTombstoneCommand(
  tombstone: string,
  entryDir: string
): string {
  const source = shellEscape(tombstone)
  const destination = shellEscape(entryDir)
  return `if [ -f ${source}/${RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME} ] && [ ! -e ${destination} ] && [ ! -L ${destination} ]; then mv ${source} ${destination} && echo MOVED; else echo BUSY; fi`
}

/** A symlinked tombstone is never followed, so only its own marker can be dropped. */
export function dropRelayNativeDepsCacheCompletionMarkerCommand(tombstone: string): string {
  const source = shellEscape(tombstone)
  return `{ [ -L ${source} ] || rm -f ${source}/${RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME}; }`
}

/** Drops the completion marker first so an interrupted deletion can never be restored as complete. */
export function removeRelayNativeDepsCacheTombstoneCommand(tombstone: string): string {
  return `${dropRelayNativeDepsCacheCompletionMarkerCommand(tombstone)} && rm -rf ${shellEscape(tombstone)}`
}
