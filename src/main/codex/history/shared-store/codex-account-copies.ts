import { type BigIntStats, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { MERGE_PENDING_SUFFIX } from '../../../filesystem/merged-directory-link'
import { SET_ASIDE_ROLLOUTS_DIR } from './codex-account-history-cleanup-manifest'
import {
  COMPRESSED_ROLLOUT_SUFFIX,
  rolloutTwinPath
} from '../rollouts/codex-rollout-compressed-twin'
import { originalHoldsCopy } from './codex-account-copy-content'
import { readKeptCopies, writeKeptCopies, type KeptCopies } from './codex-account-copies-kept'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'
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

/** A copy whose bytes its ~/.codex original holds, with both files as they were checked. */
export type VerifiedCopy = { copy: string; original: string; copyKey: string; originalKey: string }

export type VerifyBudget = { maxBytes: number; deadline: number }

// Inode, size and mtime: any write, replace or compression since the check changes one of them.
function fileKey(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
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
  for (const name of HISTORY_FOLDERS) {
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
}): Promise<{ verified: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }> {
  const tally = emptyTally()
  const verified: VerifiedCopy[] = []
  const kept = readKeptCopies(args.accountHome)
  const nextKept: KeptCopies = {}
  let bytesRead = 0
  for (const root of listCopyRoots(args.accountHome, args.storeHome)) {
    for (const copy of rolloutFiles(root.root)) {
      const name = relative(args.accountHome, copy).split(/[\\/]/).join('/')
      try {
        const copyStats = lstatOrNull(copy)
        if (!copyStats?.isFile()) {
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
        const key = `${fileKey(copyStats)}|${original.path}|${fileKey(original.stats)}`
        const sameForm =
          copy.endsWith(COMPRESSED_ROLLOUT_SUFFIX) ===
          original.path.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
        if (kept[name] === key || (sameForm && copyStats.size > original.stats.size)) {
          nextKept[name] = key
          tally.differs += 1
          continue
        }
        const size = Number(copyStats.size)
        if (bytesRead + size > args.budget.maxBytes || Date.now() > args.budget.deadline) {
          tally.deferred += 1
          if (kept[name]) {
            nextKept[name] = kept[name]
          }
          continue
        }
        bytesRead += size
        let holds: boolean
        try {
          holds = await originalHoldsCopy(copy, original.path)
        } catch (error) {
          // A corrupt `.zst` never matches; anything else is tried again next launch.
          const code =
            typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
          if (!code.startsWith('ZSTD_')) {
            throw error
          }
          holds = false
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
  writeKeptCopies(args.accountHome, nextKept)
  return { verified, tally, bytesRead }
}

function removeEmptyFolders(folder: string): void {
  let entries
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeEmptyFolders(join(folder, entry.name))
    }
  }
  try {
    rmdirSync(folder)
  } catch {
    // Not empty, or held: it stays.
  }
}

/**
 * Deletes each verified copy that no process has open, only if neither file changed since its
 * check; then removes folders the deletes emptied.
 */
export function deleteVerifiedCodexAccountCopies(args: {
  accountHome: string
  storeHome: string
  copies: VerifiedCopy[]
}): CopiesTally {
  const tally = emptyTally()
  for (const copy of args.copies) {
    try {
      const copyStats = lstatOrNull(copy.copy)
      const originalStats = lstatOrNull(copy.original)
      if (
        !copyStats?.isFile() ||
        !originalStats?.isFile() ||
        copyStats.nlink > 1n ||
        fileKey(copyStats) !== copy.copyKey ||
        fileKey(originalStats) !== copy.originalKey
      ) {
        tally.changed += 1
        continue
      }
      unlinkSync(copy.copy)
      tally.deleted += 1
      tally.bytesReclaimed += Number(copyStats.size)
    } catch {
      tally.error += 1
    }
  }
  if (tally.deleted > 0) {
    for (const root of listCopyRoots(args.accountHome, args.storeHome)) {
      removeEmptyFolders(root.root)
    }
    const setAside = join(args.accountHome, SET_ASIDE_ROLLOUTS_DIR)
    if (realDirectory(setAside)) {
      removeEmptyFolders(setAside)
    }
  }
  return tally
}

export async function runCodexAccountCopiesRequest(
  request: CodexAccountCopiesRequest
): Promise<CodexAccountCopiesResponse> {
  if (request.op === 'verify') {
    return { ok: true, ...(await verifyCodexAccountCopies(request)) }
  }
  return { ok: true, verified: [], tally: deleteVerifiedCodexAccountCopies(request), bytesRead: 0 }
}
