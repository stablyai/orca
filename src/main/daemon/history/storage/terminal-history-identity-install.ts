import { constants, lstatSync, rmdirSync, unlinkSync, type Stats } from 'node:fs'
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rmdir,
  unlink
} from 'node:fs/promises'
import { join } from 'node:path'
import { PrioritySemaphore } from '../../../../shared/priority-semaphore'
import { syncDirectory, writeTempFileDurable } from '../../../filesystem/durable-file-write'
import { publishFileWithoutOverwrite } from '../../../filesystem/publish-file-without-overwrite'
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE
} from '../../endpoint/publication/daemon-private-file-modes'
import { HistoryReader } from '../restoration/history-reader'
import { getHistorySessionDirName } from './history-paths'
import {
  TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
  TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES,
  TERMINAL_HISTORY_LOG_MAX_BYTES,
  TERMINAL_HISTORY_META_MAX_BYTES
} from './terminal-history-file-limits'
import {
  newTerminalHistoryMeta,
  readTerminalHistoryMeta,
  type SessionMeta
} from './terminal-history-metadata'
import {
  fingerprintTerminalHistorySession,
  fingerprintTerminalHistoryEntries,
  hasTerminalHistoryRecoveryProtection
} from './terminal-history-recovery-quarantine'
import type { TerminalHistoryMigrationLease, TerminalHistoryRoot } from './terminal-history-root'

const copyCapacity = new PrioritySemaphore(1)
const fileLimits: Readonly<Record<string, number>> = {
  'meta.json': TERMINAL_HISTORY_META_MAX_BYTES,
  'checkpoint.json': TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
  'output.log': TERMINAL_HISTORY_LOG_MAX_BYTES,
  'scrollback.bin': TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES
}

/** Metadata publication selects the identity even if its caller never received the result. */
export function hasCommittedTerminalHistoryIdentity(root: string, sessionId: string): boolean {
  try {
    return (
      lstatSync(join(root, getHistorySessionDirName(sessionId), 'meta.json'), {
        throwIfNoEntry: false
      }) !== undefined
    )
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
  }
}

async function sourceFiles(
  root: string,
  id: string
): Promise<{ files: string[]; fingerprint: string | null } | null> {
  const dir = join(root, getHistorySessionDirName(id))
  const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (!info) {
    return { files: [], fingerprint: null }
  }
  if (!info.isDirectory() || hasTerminalHistoryRecoveryProtection(root, id)) {
    return null
  }
  const files = (await readdir(dir)).sort()
  const entries: [string, Stats][] = [['.', info]]
  if (!files.includes('meta.json') || readTerminalHistoryMeta(root, id).status !== 'readable') {
    return null
  }
  for (const name of files) {
    if (!Object.hasOwn(fileLimits, name)) {
      return null
    }
    const stat = await lstat(join(dir, name))
    entries.push([name, stat])
    if (!stat.isFile() || stat.size > fileLimits[name]) {
      return null
    }
  }
  const recovery = await new HistoryReader(root).detectColdRestoreState(id, {
    ignoreCleanEnd: true
  })
  if (
    recovery.status === 'unreadable' ||
    (recovery.status === 'restored' && recovery.hasUnreadableRecovery)
  ) {
    return null
  }
  return { files, fingerprint: fingerprintTerminalHistoryEntries(entries) }
}

/** Copy existing-format recovery without ever sharing source inodes or replacing a destination. */
export async function installTerminalHistoryIdentity(
  root: TerminalHistoryRoot,
  originalId: string,
  canonicalId: string,
  initial: Pick<SessionMeta, 'cwd' | 'cols' | 'rows'>,
  eligible: () => boolean,
  signal?: AbortSignal
): Promise<'legacy' | 'canonical'> {
  if (hasCommittedTerminalHistoryIdentity(root.path, canonicalId)) {
    return 'canonical'
  }
  const releaseCopy = await copyCapacity.acquire(0, signal)
  let lease: TerminalHistoryMigrationLease | null = null
  const isEligible = () => !signal?.aborted && eligible()
  const abort = () => lease?.release()
  const source = join(root.path, getHistorySessionDirName(originalId))
  const target = join(root.path, getHistorySessionDirName(canonicalId))
  let staging: string | undefined
  const staged: string[] = []
  const published = new Map<string, Stats>()
  let targetOwner: ReturnType<TerminalHistoryRoot['retainUnpublishedTarget']> | undefined
  let targetIdentity: Stats | undefined
  let ownsTarget = false
  let committed = false
  try {
    signal?.addEventListener('abort', abort, { once: true })
    lease = await root.beginMigration([originalId, canonicalId], isEligible)
    if (!lease) {
      return 'legacy'
    }
    if (hasCommittedTerminalHistoryIdentity(root.path, canonicalId)) {
      return 'canonical'
    }
    const listing = await sourceFiles(root.path, originalId)
    if (!listing || !lease.current()) {
      return 'legacy'
    }
    const { files, fingerprint } = listing
    if (fingerprintTerminalHistorySession(root.path, originalId, files) !== fingerprint) {
      return 'legacy'
    }
    staging = await mkdtemp(join(root.path, '.identity-copy-'))
    await chmod(staging, PRIVATE_DIR_MODE)
    // Staging never has meta.json, so restorable-session discovery cannot expose it as a terminal.
    const stageName = (name: string) => (name === 'meta.json' ? 'meta.commit' : name)
    for (const name of files) {
      const path = join(staging, stageName(name))
      staged.push(path)
      await copyFile(join(source, name), path, constants.COPYFILE_EXCL)
      await chmod(path, PRIVATE_FILE_MODE)
      const handle = await open(path, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (!lease.current()) {
        return 'legacy'
      }
    }
    if (!files.length) {
      const path = join(staging, 'meta.commit')
      staged.push(path)
      await writeTempFileDurable(
        path,
        JSON.stringify(newTerminalHistoryMeta(initial, null)),
        PRIVATE_FILE_MODE
      )
    }
    if (!lease.current()) {
      return 'legacy'
    }
    targetOwner = root.retainUnpublishedTarget(canonicalId)
    await mkdir(target, { mode: PRIVATE_DIR_MODE })
    ownsTarget = true
    targetIdentity = await lstat(target)
    for (const name of files.filter((name) => name !== 'meta.json')) {
      if (!lease.current()) {
        return 'legacy'
      }
      await link(join(staging, name), join(target, name))
      published.set(join(target, name), await lstat(join(target, name)))
    }
    await syncDirectory(target)
    await syncDirectory(root.path)
    if (
      !lease.current() ||
      fingerprintTerminalHistorySession(root.path, originalId, files) !== fingerprint
    ) {
      return 'legacy'
    }
    committed = publishFileWithoutOverwrite(join(staging, 'meta.commit'), join(target, 'meta.json'))
    if (!committed) {
      if (hasCommittedTerminalHistoryIdentity(root.path, canonicalId)) {
        return 'canonical'
      }
      return 'legacy'
    }
    await syncDirectory(target)
    await syncDirectory(root.path)
    return 'canonical'
  } catch (error) {
    if (committed || hasCommittedTerminalHistoryIdentity(root.path, canonicalId)) {
      throw error
    }
    return 'legacy'
  } finally {
    if (ownsTarget && targetIdentity && !committed && targetOwner?.current()) {
      await removeOwnedIncompleteTarget(target, targetIdentity, published, targetOwner.current)
    }
    targetOwner?.release()
    signal?.removeEventListener('abort', abort)
    lease?.release()
    for (const path of staged) {
      await unlink(path).catch(() => {})
    }
    if (staging) {
      await rmdir(staging).catch(() => {})
    }
    releaseCopy()
  }
}

const sameFile = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mode === b.mode &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs

async function removeOwnedIncompleteTarget(
  target: string,
  identity: Stats,
  published: ReadonlyMap<string, Stats>,
  current: () => boolean
): Promise<void> {
  try {
    const before = await lstat(target)
    if (before.dev !== identity.dev || before.ino !== identity.ino) {
      return
    }
    const entries = await readdir(target)
    if (
      entries.length !== published.size ||
      entries.some((name) => !published.has(join(target, name)))
    ) {
      return
    }
    // The asynchronous listing is bounded above; this final proof and deletion cannot yield to a local writer.
    if (
      !current() ||
      !sameFile(before, lstatSync(target)) ||
      [...published].some(([path, info]) => !sameFile(info, lstatSync(path)))
    ) {
      return
    }
    for (const path of published.keys()) {
      unlinkSync(path)
    }
    rmdirSync(target)
  } catch {
    // A foreign entry, changed identity or failed proof retains the target conservatively.
  }
}
