import { type BigIntStats, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { MERGE_PENDING_SUFFIX } from '../../../filesystem/merged-directory-link'
import {
  HISTORY_CLEANUP_MANIFEST,
  SET_ASIDE_ROLLOUTS_DIR
} from './codex-account-history-cleanup-manifest'
import {
  COMPRESSED_ROLLOUT_SUFFIX,
  rolloutTwinPath
} from '../rollouts/codex-rollout-compressed-twin'
import { OutOfTime, originalHoldsCopy } from './codex-account-copy-content'
import { readKeptCopies, writeKeptCopies, type KeptCopies } from './codex-account-copies-kept'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'
import {
  deleteCheckedCopies,
  fileKey,
  isInsideHome,
  lstatOrNull,
  onlyOwnerWrites,
  removeEmptyFolders,
  type VerifiedCopy
} from './codex-account-copies-delete'
import { assertOwnedHostCodexManagedHomePath } from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'
import type {
  CodexAccountCopiesRequest,
  CodexAccountCopiesResponse
} from './codex-account-copies-worker-protocol'

// Sync file calls on purpose: this runs on its own worker thread (see the worker entry).

const HISTORY_FOLDERS = ['sessions', 'archived_sessions']
// `sessions.orca-profile-merge`, or `sessions.<ms>.orca-profile-merge` when sharing was toggled.
const MERGE_FOLDER = new RegExp(
  `^(${HISTORY_FOLDERS.join('|')})(?:\\.\\d+)?${MERGE_PENDING_SUFFIX.replaceAll('.', '\\.')}$`
)
const ROLLOUT_FILE = /^rollout-.*\.jsonl(?:\.zst)?$/
const ACL_KEEP = 'acl:'
// What one launch's delete phase can get through; the rest is verified again next launch.
const MAX_VERIFIED_PER_HOME = 5_000

/**
 * `maxBytes`: what this home may still read of copies and originals together; `admitOversized`:
 * nothing has been read yet this launch, so one file larger than the whole budget may go first.
 */
export type VerifyBudget = { maxBytes: number; deadline: number; admitOversized: boolean }

// The share streak's start: sharing turned off and on again can leave new conflict copies.
function sharedSince(accountHome: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(accountHome, HISTORY_CLEANUP_MANIFEST), 'utf8')
    )
    return parsed &&
      typeof parsed === 'object' &&
      'firstSharedAt' in parsed &&
      typeof parsed.firstSharedAt === 'string'
      ? parsed.firstSharedAt
      : null
  } catch {
    return null
  }
}

function realDirectory(path: string): boolean {
  const stats = lstatOrNull(path)
  // Never a link: a junction or symlink here is not Orca's copy.
  return stats !== null && stats.isDirectory() && !stats.isSymbolicLink()
}

type CopyRoot = { root: string; storeFolder: string; twinOnly: boolean }

/** Where sharing left the home's own forms of rollouts that ~/.codex already had. */
export function listCopyRoots(accountHome: string, storeHome: string): CopyRoot[] {
  const roots: CopyRoot[] = []
  for (const entry of readdirSync(accountHome, { withFileTypes: true })) {
    const match = entry.isDirectory() ? MERGE_FOLDER.exec(entry.name) : null
    if (match) {
      roots.push({
        root: join(accountHome, entry.name),
        storeFolder: join(storeHome, match[1]),
        twinOnly: false
      })
    }
  }
  for (const name of realDirectory(join(accountHome, SET_ASIDE_ROLLOUTS_DIR))
    ? HISTORY_FOLDERS
    : []) {
    roots.push({
      root: join(accountHome, SET_ASIDE_ROLLOUTS_DIR, name),
      storeFolder: join(storeHome, name),
      twinOnly: true
    })
  }
  return roots.filter((root) => realDirectory(root.root))
}

function* rolloutFiles(folder: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return
    }
    throw error
  }
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      yield* rolloutFiles(path)
    } else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) {
      yield path
    }
  }
}

// The same name in ~/.codex, else its other form (Codex compressed it since).
function findOriginal(
  root: CopyRoot,
  copy: string
): { path: string; stats: BigIntStats } | null | 'error' {
  const sameName = join(root.storeFolder, relative(root.root, copy))
  const candidates = root.twinOnly
    ? [rolloutTwinPath(sameName)]
    : [sameName, rolloutTwinPath(sameName)]
  for (const path of candidates) {
    const stats = lstatOrNull(path)
    if (stats?.isFile()) {
      return { path, stats }
    }
    if (stats) {
      return 'error'
    }
  }
  return null
}

/**
 * Compares each rollout copy the home kept with its ~/.codex original, within `budget` (copies past
 * it wait for a later launch). Deletes nothing: the copies it returns still need the open check.
 */
export async function verifyCodexAccountCopies(args: {
  accountHome: string
  storeHome: string
  budget: VerifyBudget
  /** This Orca's version: a home this version settled, in the same share streak, isn't walked. */
  version: string
  managedAccountsRoot: string
}): Promise<{ verified: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }> {
  const tally = emptyTally()
  const verified: VerifiedCopy[] = []
  // Throws unless this is Orca's own account home (its marker names its account).
  assertOwnedHostCodexManagedHomePath({
    candidatePath: args.accountHome,
    managedAccountsRoot: args.managedAccountsRoot,
    systemCodexHomePath: args.storeHome,
    expectedAccountId: basename(dirname(args.accountHome))
  })
  const since = sharedSince(args.accountHome)
  const stamp = since === null ? null : `${args.version}|${since}`
  const record = readKeptCopies(args.accountHome)
  if (stamp !== null && record.settled === stamp) {
    return { verified, tally, bytesRead: 0 }
  }
  const kept = record.differs
  const nextKept: KeptCopies = {}
  const visited = new Set<string>()
  let bytesRead = 0
  let outOfTime = false
  scan: for (const root of listCopyRoots(args.accountHome, args.storeHome)) {
    for (const copy of rolloutFiles(root.root)) {
      const name = relative(args.accountHome, copy).split(/[\\/]/).join('/')
      if (Date.now() > args.budget.deadline || verified.length >= MAX_VERIFIED_PER_HOME) {
        // The rest waits for a later launch, unvisited: its cost stays within the deadline.
        outOfTime = true
        tally.deferred += 1
        break scan
      }
      visited.add(name)
      try {
        const copyStats = lstatOrNull(copy)
        if (!copyStats?.isFile()) {
          continue
        }
        if (!isInsideHome(args.accountHome, copy)) {
          tally.error += 1
          continue
        }
        const original = findOriginal(root, copy)
        if (original === 'error') {
          tally.error += 1
          continue
        }
        if (!original) {
          tally.missing_original += 1
          continue
        }
        // Another name for the copy's bytes could be a live writer's.
        if (copyStats.nlink > 1n || original.stats.ino === copyStats.ino) {
          tally.linked += 1
          continue
        }
        // Another user could write it, and no open check sees their processes: kept unread.
        if (!onlyOwnerWrites(copyStats)) {
          tally.open += 1
          continue
        }
        const key = `${fileKey(copyStats)}|${original.path}|${fileKey(original.stats)}`
        const sameForm =
          copy.endsWith(COMPRESSED_ROLLOUT_SUFFIX) ===
          original.path.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
        // One form compressed and the other not: kept. Decoding can't prove a `.zst` complete
        // (a cut-off frame or checksum still decodes), so content is only compared as stored.
        if (!sameForm) {
          tally.compressed += 1
          continue
        }
        // Kept last launch for an ACL: not read or offered again until either file changes, so
        // lasting keeps never fill a launch's candidates ahead of the copies behind them.
        if (kept[name] === `${ACL_KEEP}${key}`) {
          nextKept[name] = kept[name]
          tally.open += 1
          continue
        }
        if (kept[name] === key || copyStats.size > original.stats.size) {
          nextKept[name] = key
          tally.differs += 1
          continue
        }
        // The most the comparison reads. A pair over the whole budget goes first, not never.
        const size = Number(copyStats.size) * 2 + 1
        const oversizedFirst = args.budget.admitOversized && bytesRead === 0
        if (!oversizedFirst && bytesRead + size > args.budget.maxBytes) {
          tally.deferred += 1
          if (kept[name]) {
            nextKept[name] = kept[name]
          }
          continue
        }
        bytesRead += size
        let holds: boolean
        try {
          holds = originalHoldsCopy(copy, original.path, copyStats.size, args.budget.deadline)
        } catch (error) {
          if (error instanceof OutOfTime) {
            tally.deferred += 1
            continue
          }
          throw error
        }
        const copyAfter = lstatOrNull(copy)
        const originalAfter = lstatOrNull(original.path)
        if (
          !copyAfter ||
          !originalAfter ||
          fileKey(copyAfter) !== fileKey(copyStats) ||
          fileKey(originalAfter) !== fileKey(original.stats)
        ) {
          tally.changed += 1
        } else if (holds) {
          verified.push({
            copy,
            original: original.path,
            copyKey: fileKey(copyStats),
            originalKey: fileKey(original.stats)
          })
        } else {
          nextKept[name] = key
          tally.differs += 1
        }
      } catch {
        tally.error += 1
      }
    }
  }
  if (outOfTime) {
    for (const [name, key] of Object.entries(kept)) {
      if (!visited.has(name)) {
        nextKept[name] = key
      }
    }
  }
  // Only what can't become deletable in this streak: a differing, open or orphaned copy could.
  const settled =
    stamp !== null &&
    verified.length === 0 &&
    tally.deferred +
      tally.changed +
      tally.error +
      tally.missing_original +
      tally.differs +
      tally.open +
      tally.busy ===
      0
  writeKeptCopies(args.accountHome, { differs: nextKept, settled: settled ? stamp : null })
  return { verified, tally, bytesRead }
}

/** Notes copies kept for an ACL, keyed to both files as compared, so later launches skip them. */
function rememberAclKeeps(accountHome: string, copies: VerifiedCopy[]): void {
  const record = readKeptCopies(accountHome)
  for (const copy of copies) {
    const name = relative(accountHome, copy.copy).split(/[\\/]/).join('/')
    record.differs[name] = `${ACL_KEEP}${copy.copyKey}|${copy.original}|${copy.originalKey}`
  }
  writeKeptCopies(accountHome, { differs: record.differs, settled: null })
}

/** Folders the deletes emptied go; anything else in them stays. */
export function removeEmptiedCopyFolders(accountHome: string, storeHome: string): void {
  for (const root of listCopyRoots(accountHome, storeHome)) {
    removeEmptyFolders(root.root)
  }
  const setAside = join(accountHome, SET_ASIDE_ROLLOUTS_DIR)
  if (realDirectory(setAside)) {
    removeEmptyFolders(setAside)
  }
}

export async function runCodexAccountCopiesRequest(
  request: CodexAccountCopiesRequest
): Promise<CodexAccountCopiesResponse> {
  switch (request.op) {
    case 'verify':
      return { ok: true, op: 'verify', ...(await verifyCodexAccountCopies(request)) }
    case 'delete':
      return {
        ok: true,
        op: 'delete',
        tally: deleteCheckedCopies(request.accountHome, request.copies, request.lockFolders)
      }
    case 'remember-acl':
      rememberAclKeeps(request.accountHome, request.copies)
      return { ok: true, op: 'remember-acl' }
    case 'prune':
      removeEmptiedCopyFolders(request.accountHome, request.storeHome)
      return { ok: true, op: 'prune' }
  }
}
