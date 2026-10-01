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
import { randomInt } from 'node:crypto'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import {
  isRelayNativeDepsCacheEntryName,
  relayNativeDepsCacheBaseDir,
  relayNativeDepsCacheNodeModulesPath,
  supportsRelayNativeDepsCache,
  RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX,
  LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX
} from './ssh-relay-native-deps-cache'
import {
  listRelayNativeDepsCacheEntriesCommand,
  listRelayNativeDepsCacheReferencesCommand,
  MAX_RELAY_NATIVE_CACHE_LISTING_ENTRIES,
  RELAY_NATIVE_CACHE_LIST_OK,
  RELAY_NATIVE_CACHE_REFS_OK,
  dropRelayNativeDepsCacheCompletionMarkerCommand,
  removeRelayNativeDepsCacheTombstoneCommand,
  restoreRelayNativeDepsCacheTombstoneCommand
} from './ssh-relay-native-deps-cache-commands'
import { moveRemoteTreeCommand } from './ssh-remote-commands'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

type ReferenceScan =
  | { readable: true; referencedKeys: Set<string> }
  /** Anything this client could not fully account for. No entry may be deleted on it. */
  | { readable: false }

function staleTombstoneKey(name: string): string | null {
  const prefix = [
    RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX,
    LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX
  ].find((value) => name.startsWith(value))
  if (!prefix) {
    return null
  }
  const match = /^(.*)\.(\d+)\.(\d+)$/.exec(name.slice(prefix.length))
  if (
    !match ||
    !isRelayNativeDepsCacheEntryName(match[1]) ||
    !Number.isSafeInteger(Number(match[3])) ||
    Date.now() - Number(match[3]) < 30 * 60_000
  ) {
    return null
  }
  return match[1]
}

function execHostCommand(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string
): Promise<string> {
  return execCommand(conn, command, {
    wrapCommand: host.commandDialect !== 'powershell'
  })
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
  let entries: CacheEntry[]
  try {
    entries = parseCacheEntryListing(
      await execHostCommand(conn, host, listRelayNativeDepsCacheEntriesCommand(host, remoteHome))
    )
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
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
  const removed: string[] = []
  for (const { name, key } of entries) {
    const keep = scan.referencedKeys.has(key) || pinned.has(key)
    const collected =
      name === key
        ? !keep && (await removeUnreferencedCacheEntry(conn, host, remoteHome, base, key))
        : await recoverAbandonedTombstone(conn, host, remoteHome, base, name, key, keep)
    if (collected) {
      removed.push(key)
    }
  }
  if (removed.length > 0) {
    console.log(
      `[relay] native-deps cache GC: removed ${removed.length} entry(ies): ${removed.join(', ')}`
    )
  }
}

// Why random rather than pid + clock: passes on different clients must never rename into one path.
function ownedTombstonePath(host: RemoteHostPlatform, base: string, key: string): string {
  const name = `${RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX}${key}.${randomInt(1, 2 ** 47)}.${Date.now()}`
  return joinRemotePath(host, base, name)
}

async function moveTree(
  conn: SshConnection,
  host: RemoteHostPlatform,
  source: string,
  destination: string
): Promise<boolean> {
  try {
    const moved = await execHostCommand(
      conn,
      host,
      moveRemoteTreeCommand(host, source, destination)
    )
    return moved.trim() === 'MOVED'
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return false
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
  const tombstone = ownedTombstonePath(host, base, key)
  if (!(await moveTree(conn, host, entryDir, tombstone))) {
    return false
  }
  return collectOwnedTombstone(conn, host, remoteHome, key, tombstone, entryDir)
}

/**
 * Another pass may list the same abandoned tombstone, so only the pass whose rename wins may
 * restore or delete it; the fresh name keeps every other pass off it for the stale window.
 */
async function recoverAbandonedTombstone(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  base: string,
  name: string,
  key: string,
  keep: boolean
): Promise<boolean> {
  const source = joinRemotePath(host, base, name)
  // Why unmark legacy trees before claiming them: an old client's mtime sweep may have left a
  // partial tree with its marker, and the marker is all a later pass checks before restoring.
  if (
    name.startsWith(LEGACY_RELAY_NATIVE_DEPS_CACHE_TOMBSTONE_PREFIX) &&
    !(await runOrDecline(conn, host, dropRelayNativeDepsCacheCompletionMarkerCommand(source)))
  ) {
    return false
  }
  const tombstone = ownedTombstonePath(host, base, key)
  if (!(await moveTree(conn, host, source, tombstone))) {
    return false
  }
  const entryDir = joinRemotePath(host, base, key)
  if (keep) {
    await restoreCacheEntry(conn, host, tombstone, entryDir)
    return false
  }
  return collectOwnedTombstone(conn, host, remoteHome, key, tombstone, entryDir)
}

async function collectOwnedTombstone(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  key: string,
  tombstone: string,
  entryDir: string
): Promise<boolean> {
  // Why recheck under the rename: a deploy that read `.deps-complete` before it moved can still
  // be creating its symlink. Its reference now names a path that no longer exists, so restoring
  // the tree is the only outcome that leaves that relay with working native deps.
  const recheck = await scanCacheReferences(conn, host, remoteHome).catch(async (err: unknown) => {
    // A read-only scan cannot conflict with restoring this pass's renamed tree.
    await restoreCacheEntry(conn, host, tombstone, entryDir).catch(() => {})
    throw err
  })
  if (!recheck.readable || recheck.referencedKeys.has(key)) {
    await restoreCacheEntry(conn, host, tombstone, entryDir)
    return false
  }
  // A failed removal is retried by a later pass after its own recheck.
  return runOrDecline(conn, host, removeRelayNativeDepsCacheTombstoneCommand(tombstone))
}

async function runOrDecline(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string
): Promise<boolean> {
  try {
    await execHostCommand(conn, host, command)
    return true
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return false
  }
}

async function restoreCacheEntry(
  conn: SshConnection,
  host: RemoteHostPlatform,
  tombstone: string,
  entryDir: string
): Promise<void> {
  await execHostCommand(
    conn,
    host,
    restoreRelayNativeDepsCacheTombstoneCommand(tombstone, entryDir)
  ).catch((err) => {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
  })
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
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
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

type CacheEntry = { name: string; key: string }

function parseCacheEntryListing(output: string): CacheEntry[] {
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  if (!lines.includes(RELAY_NATIVE_CACHE_LIST_OK)) {
    return []
  }
  const entries: CacheEntry[] = []
  for (const line of lines) {
    if (!line.startsWith('ENTRY ')) {
      continue
    }
    const name = line.slice('ENTRY '.length)
    // Why re-validate a name the host produced: it is about to be interpolated into `mv` and
    // `rm -rf`. Only names this client could itself have minted are eligible.
    const key = isRelayNativeDepsCacheEntryName(name) ? name : staleTombstoneKey(name)
    if (key && entries.length < MAX_RELAY_NATIVE_CACHE_LISTING_ENTRIES) {
      entries.push({ name, key })
    }
  }
  return entries
}
