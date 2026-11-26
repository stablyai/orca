import { type BigIntStats, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { MERGE_PENDING_SUFFIX } from '../../../filesystem/merged-directory-link'
import { SET_ASIDE_ROLLOUTS_DIR } from './codex-account-history-cleanup-manifest'
import {
  COMPRESSED_ROLLOUT_SUFFIX,
  rolloutTwinPath
} from '../rollouts/codex-rollout-compressed-twin'
import { OutOfTime, originalHoldsCopy } from './codex-account-copy-content'
import { readKeptCopies, writeKeptCopies, type KeptCopies } from './codex-account-copies-kept'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'
import {
  fileKey,
  finishHeldCopies,
  holdVerifiedCopies,
  isInsideHome,
  lstatOrNull,
  releaseLeftoverHeldCopies,
  removeEmptyFolders,
  type VerifiedCopy
} from './codex-account-copies-hold'
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

export type VerifyBudget = { maxBytes: number; deadline: number }

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
  /** This Orca's version: a home this version already settled is not walked again. */
  version: string
}): Promise<{ verified: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }> {
  const tally = emptyTally()
  const verified: VerifiedCopy[] = []
  releaseLeftoverHeldCopies(args.accountHome)
  const record = readKeptCopies(args.accountHome)
  if (record.settled === args.version) {
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
      if (Date.now() > args.budget.deadline) {
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
        // A copy larger than the whole budget goes first in its launch rather than never.
        if (bytesRead > 0 && bytesRead + size > args.budget.maxBytes) {
          tally.deferred += 1
          if (kept[name]) {
            nextKept[name] = kept[name]
          }
          continue
        }
        bytesRead += size
        let holds: boolean
        try {
          holds = await originalHoldsCopy(copy, original.path, args.budget.deadline)
        } catch (error) {
          if (error instanceof OutOfTime) {
            tally.deferred += 1
            continue
          }
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
  if (outOfTime) {
    for (const [name, key] of Object.entries(kept)) {
      if (!visited.has(name)) {
        nextKept[name] = key
      }
    }
  }
  const settled =
    verified.length === 0 && tally.deferred + tally.changed + tally.error + tally.open === 0
  writeKeptCopies(args.accountHome, { differs: nextKept, settled: settled ? args.version : null })
  return { verified, tally, bytesRead }
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
    case 'hold':
      return { ok: true, op: 'hold', ...holdVerifiedCopies(request.accountHome, request.copies) }
    case 'finish': {
      const tally = finishHeldCopies(request.accountHome, request.held, request.open)
      if (tally.deleted > 0) {
        removeEmptiedCopyFolders(request.accountHome, request.storeHome)
      }
      return { ok: true, op: 'finish', tally }
    }
  }
}
