/**
 * Garbage collection for the shared native-deps cache.
 *
 * This is the part that can hurt: a cache entry is the only copy of node-pty for every relay
 * directory that links to it, so a wrong deletion takes native modules away from a running relay.
 * The discipline is `remote-install-gc.ts`': **an unanswered probe blocks deletion.** A listing
 * that does not end in its own OK token, a symlink whose target will not read, a reference whose
 * shape this client does not recognise — each aborts the entire pass rather than narrowing it.
 * Loss of contact is never evidence that a tree is unreferenced
 * (`docs/reference/ssh-execution-boundary.md`).
 *
 * Deletion is then the same three-step move `remote-install-gc.ts` uses for version dirs: rename
 * to a tombstone, re-read the references under the rename, and only then remove. A deploy that
 * linked the entry between the first listing and the rename shows up in the recheck, and its tree
 * is moved back.
 */
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  isRelayNativeDepsCacheEntryName,
  relayNativeDepsCacheBaseDir,
  relayNativeDepsCacheNodeModulesPath,
  supportsRelayNativeDepsCache,
  RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX
} from './ssh-relay-native-deps-cache'
import {
  listRelayNativeDepsCacheEntriesCommand,
  listRelayNativeDepsCacheReferencesCommand,
  MAX_RELAY_NATIVE_CACHE_LISTING_ENTRIES,
  RELAY_NATIVE_CACHE_LIST_OK,
  RELAY_NATIVE_CACHE_REFS_OK
} from './ssh-relay-native-deps-cache-commands'
import { moveRemoteTreeCommand, removeRemoteTreeCommand } from './ssh-remote-commands'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

type ReferenceScan =
  | { readable: true; referencedKeys: Set<string> }
  /** Anything this client could not fully account for. No entry may be deleted on it. */
  | { readable: false }

function execHostCommand(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string
): Promise<string> {
  return execCommand(conn, command, { wrapCommand: host.commandDialect !== 'powershell' })
}

/**
 * Remove complete cache entries that nothing links to.
 *
 * `pinnedKeys` is the connection's own key. The referencing symlink is written before the entry
 * becomes listable, so a live entry is already protected by the reference scan; the pin is there
 * so a deploy that fell back to a per-directory install cannot have its key deleted underneath a
 * retry either.
 */
export async function gcRelayNativeDepsCache(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  options?: { pinnedKeys?: readonly string[] }
): Promise<void> {
  if (!supportsRelayNativeDepsCache(host)) {
    return
  }
  const base = relayNativeDepsCacheBaseDir(host, remoteHome)
  let entries: string[]
  try {
    entries = parseCacheEntryListing(
      await execHostCommand(conn, host, listRelayNativeDepsCacheEntriesCommand(host, remoteHome))
    )
  } catch {
    return
  }
  if (entries.length === 0) {
    return
  }
  const scan = await scanCacheReferences(conn, host, remoteHome)
  if (!scan.readable) {
    return
  }
  const pinned = new Set(options?.pinnedKeys ?? [])
  const candidates = entries.filter((key) => !scan.referencedKeys.has(key) && !pinned.has(key))
  const removed: string[] = []
  for (const key of candidates) {
    if (await removeUnreferencedCacheEntry(conn, host, remoteHome, base, key)) {
      removed.push(key)
    }
  }
  if (removed.length > 0) {
    console.log(
      `[relay] native-deps cache GC: removed ${removed.length} entry(ies): ${removed.join(', ')}`
    )
  }
}

async function removeUnreferencedCacheEntry(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  base: string,
  key: string
): Promise<boolean> {
  const entryDir = joinRemotePath(host, base, key)
  const tombstone = joinRemotePath(
    host,
    base,
    `${RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX}${key}.${process.pid}.${Date.now()}`
  )
  try {
    const moved = await execHostCommand(
      conn,
      host,
      moveRemoteTreeCommand(host, entryDir, tombstone)
    )
    if (moved.trim() !== 'MOVED') {
      return false
    }
  } catch {
    return false
  }
  // Why recheck under the rename: a deploy that read `.deps-complete` before it moved can still
  // be creating its symlink. Its reference now names a path that no longer exists, so restoring
  // the tree is the only outcome that leaves that relay with working native deps.
  let recheck: ReferenceScan
  try {
    recheck = await scanCacheReferences(conn, host, remoteHome)
  } catch {
    recheck = { readable: false }
  }
  if (!recheck.readable || recheck.referencedKeys.has(key)) {
    await execHostCommand(conn, host, moveRemoteTreeCommand(host, tombstone, entryDir)).catch(
      () => {}
    )
    return false
  }
  try {
    await execHostCommand(conn, host, removeRemoteTreeCommand(host, tombstone))
    return true
  } catch {
    // The sweep in the entry listing drains a tombstone this pass could not remove.
    return false
  }
}

async function scanCacheReferences(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string
): Promise<ReferenceScan> {
  let output: string
  try {
    output = await execHostCommand(
      conn,
      host,
      listRelayNativeDepsCacheReferencesCommand(host, remoteHome)
    )
  } catch {
    return { readable: false }
  }
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  if (!lines.includes(RELAY_NATIVE_CACHE_REFS_OK)) {
    return { readable: false }
  }
  const referencedKeys = new Set<string>()
  const base = relayNativeDepsCacheBaseDir(host, remoteHome)
  for (const line of lines) {
    if (!line.startsWith('REF ')) {
      continue
    }
    const attribution = attributeReference(line.slice('REF '.length), base, host, remoteHome)
    if (attribution.kind === 'unattributable') {
      return { readable: false }
    }
    if (attribution.kind === 'entry') {
      referencedKeys.add(attribution.key)
    }
  }
  return { readable: true, referencedKeys }
}

type ReferenceAttribution =
  | { kind: 'entry'; key: string }
  /** A link that points somewhere else entirely; it holds no cache entry alive. */
  | { kind: 'outside' }
  | { kind: 'unattributable' }

/**
 * Which cache entry a symlink target names.
 *
 * A relative target is `unattributable` on purpose. Every link Orca writes is absolute, so a
 * relative one is a tree with a history this pass cannot reconstruct, and guessing which entry it
 * resolves to is exactly the inference that deletes a live relay's modules.
 */
function attributeReference(
  target: string,
  base: string,
  host: RemoteHostPlatform,
  remoteHome: string
): ReferenceAttribution {
  if (!target.startsWith('/') || target.includes('/../') || target.endsWith('/..')) {
    return { kind: 'unattributable' }
  }
  if (!target.startsWith(`${base}/`)) {
    return { kind: 'outside' }
  }
  const rest = target.slice(base.length + 1).split('/')
  if (
    rest.length !== 2 ||
    rest[1] !== 'node_modules' ||
    !isRelayNativeDepsCacheEntryName(rest[0])
  ) {
    return { kind: 'unattributable' }
  }
  // Why rebuild the path rather than trust the split: the target must be exactly what this client
  // writes for that key, not merely something that parses into two plausible segments.
  return target === relayNativeDepsCacheNodeModulesPath(host, remoteHome, rest[0])
    ? { kind: 'entry', key: rest[0] }
    : { kind: 'unattributable' }
}

function parseCacheEntryListing(output: string): string[] {
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  if (!lines.includes(RELAY_NATIVE_CACHE_LIST_OK)) {
    return []
  }
  const entries: string[] = []
  for (const line of lines) {
    if (!line.startsWith('ENTRY ')) {
      continue
    }
    const name = line.slice('ENTRY '.length)
    // Why re-validate a name the host produced: it is about to be interpolated into `mv` and
    // `rm -rf`. Only names this client could itself have minted are eligible.
    if (
      isRelayNativeDepsCacheEntryName(name) &&
      entries.length < MAX_RELAY_NATIVE_CACHE_LISTING_ENTRIES
    ) {
      entries.push(name)
    }
  }
  return entries
}
