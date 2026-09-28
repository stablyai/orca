/** Historical cache identities remain recognizable while older relay owners may use them. */
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { RELAY_BUILD_PLATFORMS } from '../../shared/relay-artifacts'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

/** Sibling of `relay-<version>` and `orcad-<version>`; owned by neither model's version GC. */
export const RELAY_NATIVE_DEPS_CACHE_DIR_NAME = 'native'

/** Written last. Its presence is the only thing that makes an entry linkable. */
export const RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME = '.deps-complete'

/** Older clients sweep the legacy prefix by mtime without checking references. */
export const RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX = '.native-gc-'
export const LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX = '.gc-tombstone.'

const CACHE_KEY_HASH_LENGTH = 16

const CACHE_ENTRY_NAME_REGEX = new RegExp(
  `^(${RELAY_BUILD_PLATFORMS.join('|')})-[0-9a-f]{${CACHE_KEY_HASH_LENGTH}}$`
)

/**
 * Whether a name the host listed is one this client may move or delete. Every GC candidate goes
 * through here before it reaches a shell.
 */
export function isRelayNativeDepsCacheEntryName(name: string): boolean {
  return CACHE_ENTRY_NAME_REGEX.test(name)
}

/** `~/.orca-remote` — the parent both relay dirs and the cache sit under. */
export function remoteInstallRootDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR)
}

/** `~/.orca-remote/native` */
export function relayNativeDepsCacheBaseDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(
    host,
    remoteInstallRootDir(host, remoteHome),
    RELAY_NATIVE_DEPS_CACHE_DIR_NAME
  )
}

/** `~/.orca-remote/native/<key>` */
export function relayNativeDepsCacheEntryDir(
  host: RemoteHostPlatform,
  remoteHome: string,
  key: string
): string {
  if (!isRelayNativeDepsCacheEntryName(key)) {
    throw new Error(`Unsafe relay native-deps cache key: ${JSON.stringify(key)}`)
  }
  return joinRemotePath(host, relayNativeDepsCacheBaseDir(host, remoteHome), key)
}

/** `~/.orca-remote/native/<key>/node_modules` — the symlink target, and the reference identity. */
export function relayNativeDepsCacheNodeModulesPath(
  host: RemoteHostPlatform,
  remoteHome: string,
  key: string
): string {
  return joinRemotePath(host, relayNativeDepsCacheEntryDir(host, remoteHome, key), 'node_modules')
}

/** Older Windows relays never used the shared cache. */
export function supportsRelayNativeDepsCache(host: RemoteHostPlatform): boolean {
  return !isWindowsRemoteHost(host)
}
