/**
 * Where the relay's compiled native dependencies live, and what their identity is keyed on.
 *
 * A relay install directory is keyed on the JS bundle hash, which moves on every commit to
 * `src/relay/` or the `src/shared/` it pulls in. `node_modules` used to live inside it, so a
 * dependency set that is a pinned constant (`RELAY_NATIVE_DEPS`) was reinstalled — and on Linux,
 * where node-pty ships no prebuild, recompiled from source — on every new bundle (#18009). The
 * directory key was coupled to the wrong quantity.
 *
 * The tree now lives at `~/.orca-remote/native/<relayPlatform>-<depsHash>/node_modules` and each
 * relay directory holds a symlink to it. Three rules make one tree safe to share:
 *
 * 1. **A published entry is immutable.** `.deps-complete` is written last, only after a probe on
 *    this host loaded both addons. Nothing installs, rebuilds or resets into a published entry: a
 *    repair detaches the symlink and installs privately, so a host with a broken toolchain can
 *    never `rm -rf node_modules/node-pty` out from under a live relay that shares the tree.
 * 2. **Publication elects one winner with `mkdir`.** The entry either does not exist (this deploy
 *    builds it privately and promotes it) or is already complete (this deploy links it). There is
 *    no window in which two deploys write one tree, so no client-side lock is needed.
 * 3. **Every failure degrades to today's per-directory install.** A host that cannot symlink,
 *    cannot create the directory, or answers nothing still deploys, one bundle at a time.
 *
 * Windows is deliberately excluded. node-pty's npm tarball ships win32 prebuilts, so there is no
 * compile to avoid there, and `node-pty-1.1.0-console-list-agent-patch.cjs` mutates the installed
 * tree in place — which rule 1 forbids for a shared one.
 *
 * Linux's `node-pty-1.1.0-master-cloexec-patch.cjs` also mutates in place, but it stays inside rule
 * 1: the deploy path runs it before promotion, and returns early on a linked entry, so it only ever
 * touches a private tree. Its bytes are in the key, so a patched build never links a pre-patch
 * entry -- and a tree whose patch was refused or rolled back is not promoted at all, because under
 * that same key it would publish the leak to every later host on the machine.
 */
import { createHash } from 'node:crypto'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { RELAY_BUILD_PLATFORMS } from '../../shared/relay-artifacts'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

/** Sibling of `relay-<version>` and `orcad-<version>`; owned by neither model's version GC. */
export const RELAY_NATIVE_DEPS_CACHE_DIR_NAME = 'native'

/** Written last. Its presence is the only thing that makes an entry linkable. */
export const RELAY_NATIVE_DEPS_CACHE_COMPLETE_NAME = '.deps-complete'

/** Hidden so the entry listing skips it, and swept by age so a crashed pass drains. */
export const RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX = '.gc-tombstone.'

/**
 * Bump when the remote install starts mutating the installed tree in a way the hashed inputs
 * below cannot see — a new `npm rebuild` flag, a new post-install step, a patch applied by
 * something other than a shipped `node-pty-*` artifact. A published entry is never repaired in
 * place; only a new key retires it.
 */
export const RELAY_NATIVE_DEPS_CACHE_EPOCH = 1

/**
 * Shipped relay artifacts that patch the installed native tree. Their bytes go into the key, so
 * changing a patch mints a new entry instead of leaving hosts on a tree built from the old one.
 */
export const RELAY_NATIVE_DEPS_PATCH_ARTIFACT_PATTERN = /^node-pty-.*\.(cjs|js|patch)$/

const CACHE_KEY_HASH_LENGTH = 16

const CACHE_ENTRY_NAME_REGEX = new RegExp(
  `^(${RELAY_BUILD_PLATFORMS.join('|')})-[0-9a-f]{${CACHE_KEY_HASH_LENGTH}}$`
)

export type RelayNativeDepsCachePatchSource = {
  filename: string
  contents: string
}

/**
 * `<relayPlatform>-<sha256 prefix>` over the dependency set, the epoch, and every patch the
 * remote install applies. Platform and arch stay in the name rather than the hash so an operator
 * reading `~/.orca-remote/native/` can tell what an entry is for.
 */
export function computeRelayNativeDepsCacheKey(input: {
  platform: string
  deps: Readonly<Record<string, string>>
  patchSources?: readonly RelayNativeDepsCachePatchSource[]
}): string {
  const hash = createHash('sha256')
  hash.update(`epoch ${RELAY_NATIVE_DEPS_CACHE_EPOCH}\n`)
  for (const [name, version] of Object.entries(input.deps).sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(`dep ${name} ${version}\n`)
  }
  const patches = [...(input.patchSources ?? [])].sort((a, b) => (a.filename < b.filename ? -1 : 1))
  for (const patch of patches) {
    hash.update(
      `patch ${patch.filename} ${createHash('sha256').update(patch.contents).digest('hex')}\n`
    )
  }
  const key = `${input.platform}-${hash.digest('hex').slice(0, CACHE_KEY_HASH_LENGTH)}`
  if (!isRelayNativeDepsCacheEntryName(key)) {
    // Why: the key reaches the host inside `mv` and `rm -rf`; an unrecognized platform must
    // disable the cache rather than arrive as a path fragment nobody validated.
    throw new Error(`Unsafe relay native-deps cache key: ${JSON.stringify(key)}`)
  }
  return key
}

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

/**
 * Windows hosts install node-pty from an npm prebuilt and then patch the tree in place, so they
 * keep the per-directory install. Nothing else about their deploy changes.
 */
export function supportsRelayNativeDepsCache(host: RemoteHostPlatform): boolean {
  return !isWindowsRemoteHost(host)
}
