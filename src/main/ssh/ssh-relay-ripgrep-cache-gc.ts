import {
  LIST_OK,
  REFS_OK,
  REFS_ERR,
  TOMBSTONE_PREFIX,
  MAX_LISTING_ENTRIES,
  cacheDir,
  listEntriesCommand,
  listReferencesCommand
} from './ssh-relay-ripgrep-cache-gc-commands'
// Relay installation references protect binaries until version GC removes their owners.
// Unknown references block deletion; tombstones are rechecked before removal.
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { BUNDLED_RIPGREP_PLATFORMS } from '../../shared/bundled-ripgrep'
import {
  moveRemoteTreeCommand,
  removeRemoteTreeCommand,
  restoreRemoteTreeCommand
} from './ssh-remote-commands'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

function entryNamePattern(): RegExp {
  const platforms = BUNDLED_RIPGREP_PLATFORMS.map((platform) =>
    platform.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('|')
  return new RegExp(`^[0-9a-f]{16}-(?:${platforms})$`)
}

const ENTRY_NAME = entryNamePattern()

// Recover abandoned deletions only after the owning pass has had time to finish.
function staleTombstoneEntry(name: string): string | null {
  if (!name.startsWith(TOMBSTONE_PREFIX)) {
    return null
  }
  const match = /^(.*)\.(\d+)\.(\d+)$/.exec(name.slice(TOMBSTONE_PREFIX.length))
  if (
    !match ||
    !ENTRY_NAME.test(match[1]) ||
    !Number.isSafeInteger(Number(match[3])) ||
    Date.now() - Number(match[3]) < 30 * 60_000
  ) {
    return null
  }
  return match[1]
}

function exec(conn: SshConnection, host: RemoteHostPlatform, command: string): Promise<string> {
  return execCommand(conn, command, { wrapCommand: !isWindowsRemoteHost(host) })
}

type ReferenceScan = { readable: true; referenced: Set<string> } | { readable: false }

function parseEntries(output: string): string[] {
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  if (!lines.includes(LIST_OK)) {
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
      (ENTRY_NAME.test(name) || staleTombstoneEntry(name)) &&
      entries.length < MAX_LISTING_ENTRIES
    ) {
      entries.push(name)
    }
  }
  return entries
}

async function scanReferences(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string
): Promise<ReferenceScan> {
  let output: string
  try {
    output = await exec(conn, host, listReferencesCommand(host, remoteHome))
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return { readable: false }
  }
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  // An empty legacy marker is unknown ownership, not an empty reference set.
  if (lines.includes(REFS_ERR) || lines.includes('REF') || !lines.includes(REFS_OK)) {
    return { readable: false }
  }
  const referenced = new Set<string>()
  for (const line of lines) {
    if (!line.startsWith('REF ')) {
      continue
    }
    const name = line.slice('REF '.length).trim()
    // An unrecognised marker is a reference this client cannot attribute, so it blocks the pass
    // rather than being ignored.
    if (!ENTRY_NAME.test(name)) {
      return { readable: false }
    }
    referenced.add(name)
  }
  return { readable: true, referenced }
}

/** Collect unreferenced ripgrep builds; unconfirmed termination stops the caller's cleanup. */
export async function gcRemoteRipgrepCache(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  options: { pinnedEntry?: string | undefined } = {}
): Promise<void> {
  try {
    const entries = parseEntries(await exec(conn, host, listEntriesCommand(host, remoteHome)))
    if (entries.length === 0) {
      return
    }
    const scan = await scanReferences(conn, host, remoteHome)
    if (!scan.readable) {
      return
    }
    const removed: string[] = []
    for (const name of entries) {
      const entry = staleTombstoneEntry(name) ?? name
      if (scan.referenced.has(entry) || entry === options.pinnedEntry) {
        if (name !== entry) {
          const base = cacheDir(host, remoteHome)
          await restoreCacheEntry(
            conn,
            host,
            joinRemotePath(host, base, name),
            joinRemotePath(host, base, entry)
          )
        }
        continue
      }
      if (
        await removeUnreferencedEntry(
          conn,
          host,
          remoteHome,
          entry,
          name === entry ? undefined : name
        )
      ) {
        removed.push(entry)
      }
    }
    if (removed.length > 0) {
      console.log(`[ssh-relay] ripgrep cache GC: removed ${removed.length}: ${removed.join(', ')}`)
    }
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    // Confirmed cleanup failures are optional; the next connect tries again.
  }
}

async function removeUnreferencedEntry(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  entry: string,
  abandonedTombstone?: string
): Promise<boolean> {
  const base = cacheDir(host, remoteHome)
  const entryDir = joinRemotePath(host, base, entry)
  const tombstone = joinRemotePath(
    host,
    base,
    abandonedTombstone ?? `${TOMBSTONE_PREFIX}${entry}.${process.pid}.${Date.now()}`
  )
  try {
    if (
      !abandonedTombstone &&
      (await exec(conn, host, moveRemoteTreeCommand(host, entryDir, tombstone))).trim() !== 'MOVED'
    ) {
      return false
    }
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return false
  }
  // Why recheck under the rename: a deploy that read this entry as present can still be writing
  // its marker. Its reference now names a path that no longer exists, so restoring the tree is
  // the only outcome that leaves that relay with a working ripgrep.
  const recheck = await scanReferences(conn, host, remoteHome).catch(async (err: unknown) => {
    // A read-only scan cannot conflict with restoring this pass's renamed tree.
    await restoreCacheEntry(conn, host, tombstone, entryDir).catch(() => {})
    throw err
  })
  if (!recheck.readable || recheck.referenced.has(entry)) {
    await restoreCacheEntry(conn, host, tombstone, entryDir)
    return false
  }
  try {
    await exec(conn, host, removeRemoteTreeCommand(host, tombstone))
    return true
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    // A later pass retries after verifying references again.
    return false
  }
}

async function restoreCacheEntry(
  conn: SshConnection,
  host: RemoteHostPlatform,
  tombstone: string,
  entryDir: string
): Promise<void> {
  await exec(conn, host, restoreRemoteTreeCommand(host, tombstone, entryDir)).catch((err) => {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
  })
}
