import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { link, lstat, mkdir, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { isCodexHistorySharedAcrossAccounts } from '../../../codex-accounts/codex-history-sharing'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { asBuffer, contentRelation, openContent } from './codex-rollout-content'
import {
  CodexHistoryConflictError,
  CodexHistoryNotSharedError,
  CodexHistoryUnreadableError,
  findThreadRelativePath,
  readCopiesInHome,
  resolveRegularCopies,
  type CodexThreadHomes,
  type ThreadCopy
} from './codex-thread-copies'

export {
  CodexHistoryConflictError,
  CodexHistoryNotSharedError,
  CodexHistoryUnreadableError,
  type CodexThreadHomes
} from './codex-thread-copies'

// A Codex thread can have one independent copy per account home: the history bridge or an account
// move falls back to copying when a hardlink fails. Which copy is current is proven from content
// alone (no saved owner, no mtime): the copy every other copy is a byte prefix of.

export type CodexThreadHistory = {
  homes: CodexThreadHomes
  historyShared: boolean
}

let threadHistorySource: (() => CodexThreadHistory) | null = null

/** Each host names its Codex homes once; a host that never does (tests) leaves resume to Codex. */
export function configureCodexThreadHistory(source: () => CodexThreadHistory): void {
  threadHistorySource = source
}

export function readConfiguredCodexThreadHistory(): CodexThreadHistory | null {
  return threadHistorySource?.() ?? null
}

/** Throws when unavailable: a resume must not skip the check it exists to make. */
export function readCodexThreadHistory(
  runtimeHome: { getHostCodexHomesForThreadCopies(): CodexThreadHomes } | null | undefined,
  settings: Pick<GlobalSettings, 'codexShareHistoryAcrossAccounts'> | undefined
): CodexThreadHistory {
  if (!runtimeHome || !settings) {
    throw new Error('Codex runtime home service is not initialized')
  }
  return {
    homes: runtimeHome.getHostCodexHomesForThreadCopies(),
    historyShared: isCodexHistorySharedAcrossAccounts(settings)
  }
}

const STAGING_DIR = 'orca-rollout-staging'

function copiesKey(copies: readonly ThreadCopy[]): string {
  return copies.map((copy) => `${copy.path}\0${copy.dev}\0${copy.ino}\0${copy.size}`).join('\n')
}

// Repeat starts with unchanged files skip the byte comparison.
const provenSources = new Map<string, { key: string; source: ThreadCopy }>()

async function proveLatestCopy(threadId: string, copies: ThreadCopy[]): Promise<ThreadCopy> {
  const key = copiesKey(copies)
  const cached = provenSources.get(threadId)
  if (cached?.key === key) {
    return cached.source
  }
  let latest = copies[0]
  for (const copy of copies.slice(1)) {
    const relation = await contentRelation(latest, copy)
    if (relation === 'diverged') {
      throw new CodexHistoryConflictError(
        'This Codex conversation has different copies in two accounts.'
      )
    }
    if (relation === 'right-extends') {
      latest = copy
    }
  }
  provenSources.set(threadId, { key, source: latest })
  return latest
}

async function stageContent(source: ThreadCopy, targetHome: string): Promise<string> {
  const stagingDir = join(targetHome, STAGING_DIR)
  await mkdir(stagingDir, { recursive: true })
  // Neither rollout-* (the bridge links those) nor *.tmp (older Codex deletes those).
  const stagedPath = join(stagingDir, `${randomUUID()}.partial`)
  await pipeline(openContent(source), createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }))
  return stagedPath
}

/** Creates the plain rollout only where none exists; an occupant must match or the start fails. */
async function publishPlainRollout(source: ThreadCopy, targetPath: string, targetHome: string) {
  await mkdir(dirname(targetPath), { recursive: true })
  if (!source.compressed) {
    try {
      await link(source.path, targetPath)
      return
    } catch (error) {
      if (isExistsError(error)) {
        await assertOccupantMatches(source, targetPath)
        return
      }
    }
  }
  const stagedPath = await stageContent(source, targetHome)
  try {
    await link(stagedPath, targetPath)
  } catch (error) {
    if (!isExistsError(error)) {
      throw error
    }
    await assertOccupantMatches(source, targetPath)
  } finally {
    await rm(stagedPath, { force: true }).catch((error: unknown) => {
      console.warn('[codex-thread-latest-copy] Failed to remove staged rollout:', error)
    })
  }
}

async function assertOccupantMatches(source: ThreadCopy, targetPath: string): Promise<void> {
  const stat = await lstat(targetPath)
  const occupant = {
    path: targetPath,
    compressed: false,
    symlink: stat.isSymbolicLink(),
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size
  }
  if (occupant.symlink || (await contentRelation(source, occupant)) !== 'same') {
    throw new CodexHistoryConflictError(
      'Another copy of this Codex conversation appeared in the selected account.'
    )
  }
}

function sameHome(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

/** Appends what an older copy lacks. Extending in place keeps any append handle on it valid. */
async function appendMissingTail(source: ThreadCopy, older: ThreadCopy): Promise<void> {
  const handle = await open(older.path, 'a')
  try {
    const now = await handle.stat()
    if (now.dev !== older.dev || now.ino !== older.ino || now.size !== older.size) {
      throw new CodexHistoryConflictError(
        'This Codex conversation changed in the selected account while Orca was updating it.'
      )
    }
    let skip = older.size
    for await (const chunk of openContent(source)) {
      const bytes = asBuffer(chunk)
      if (skip >= bytes.length) {
        skip -= bytes.length
        continue
      }
      await handle.appendFile(bytes.subarray(skip))
      skip = 0
    }
  } finally {
    await handle.close()
  }
}

/**
 * Make `targetHome` hold the newest copy of the thread, or refuse visibly. An existing rollout file
 * is only ever extended, never replaced: Codex writers keep their append handle open.
 */
export async function prepareLatestCodexThreadCopy(args: {
  threadId: string
  targetHome: string
  homes: CodexThreadHomes
  historyShared: boolean
}): Promise<void> {
  if (args.homes.unreadable) {
    throw new CodexHistoryUnreadableError()
  }
  const homes = [
    args.targetHome,
    ...args.homes.homes.filter((home) => !sameHome(home, args.targetHome))
  ]
  const relativePlainPath = await findThreadRelativePath(args.threadId, homes)
  if (!relativePlainPath) {
    // Never saved; Codex's own resume refusal decides what happens next.
    return
  }
  const targetCopies = await readCopiesInHome(args.targetHome, relativePlainPath)
  const otherCopies = (
    await Promise.all(homes.slice(1).map((home) => readCopiesInHome(home, relativePlainPath)))
  ).flat()
  const candidates = await resolveRegularCopies([...targetCopies, ...otherCopies])
  if (candidates.length === 0) {
    return
  }
  const source = await proveLatestCopy(args.threadId, candidates)
  const plainTargetPath = join(args.targetHome, 'sessions', relativePlainPath)
  const plainOccupant = targetCopies.find((copy) => copy.path === plainTargetPath)
  const otherTargetCopies = targetCopies.filter((copy) => !copy.symlink && copy !== plainOccupant)
  for (const copy of otherTargetCopies) {
    if ((await contentRelation(source, copy)) !== 'same') {
      throw new CodexHistoryConflictError(
        'The selected Codex account has an older or different copy of this conversation.'
      )
    }
  }
  // Codex resumes a bridge link through to the copy it names and appends there.
  const resumed = plainOccupant && (await resolveRegularCopies([plainOccupant]))[0]
  if (resumed) {
    const relation = await contentRelation(source, resumed)
    if (relation === 'same') {
      return
    }
    // A return to an account an earlier move could only copy into, not link.
    if (relation !== 'left-extends') {
      throw new CodexHistoryConflictError(
        'The selected Codex account has an older or different copy of this conversation.'
      )
    }
    if (!args.historyShared) {
      throw new CodexHistoryNotSharedError()
    }
    await appendMissingTail(source, resumed)
    return
  }
  if (!plainOccupant && otherTargetCopies.length > 0) {
    return
  }
  if (!args.historyShared) {
    throw new CodexHistoryNotSharedError()
  }
  await publishPlainRollout(source, plainTargetPath, args.targetHome)
}

function isExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
