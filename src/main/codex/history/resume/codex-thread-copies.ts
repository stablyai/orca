import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import { listCodexSessionRolloutFilesIncrementally } from '../rollouts/codex-session-file-listing'
import { codexDatedRolloutRelativePath } from './codex-session-resume-home'

// Where a Codex thread's copies sit in each account home. A move or the history bridge keeps a
// copy's dated path, so one `YYYY/MM/DD/rollout-*.jsonl` tail locates it in every home.

/** The account the chat moves to lacks the conversation and history sharing is off (11-03 ruling). */
export class CodexHistoryNotSharedError extends Error {
  constructor() {
    super("The selected Codex account doesn't have this conversation and history sharing is off.")
    this.name = 'CodexHistoryNotSharedError'
  }
}

/** Copies diverged, or the target holds an older or linked copy Orca must not replace. */
export class CodexHistoryConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexHistoryConflictError'
  }
}

/** A home that may hold the newest copy could not be read, so no copy can be proven current. */
export class CodexHistoryUnreadableError extends Error {
  constructor(cause?: unknown) {
    super("Orca can't read every Codex account's history right now. Try again.", { cause })
    this.name = 'CodexHistoryUnreadableError'
  }
}

export type ThreadCopy = {
  path: string
  compressed: boolean
  symlink: boolean
  dev: number
  ino: number
  size: number
}

export type CodexThreadHomes = {
  /** Every host home that can hold this thread; an unreadable one makes `unreadable` true. */
  homes: readonly string[]
  unreadable: boolean
}

/** The `YYYY/MM/DD/rollout-*.jsonl` tail is the same in every home: copies keep their path. */
function threadCopyPaths(home: string, relativePlainPath: string): string[] {
  const plain = join(home, 'sessions', relativePlainPath)
  const archived = join(home, 'archived_sessions', basename(relativePlainPath))
  return [plain, `${plain}.zst`, archived, `${archived}.zst`]
}

const DAY_MS = 24 * 60 * 60 * 1000
const relativePaths = new Map<string, string>()

/** Codex names a thread with a v7 UUID, so its creation day narrows the dated folders to probe. */
function threadCreationDays(threadId: string): string[] {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7/i.exec(threadId)
  if (!match) {
    return []
  }
  const createdAt = Number.parseInt(match[1] + match[2], 16)
  // Codex dates the folder in local time; one day either side covers every time zone.
  return [-1, 0, 1].map((offset) => {
    const day = new Date(createdAt + offset * DAY_MS)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${day.getUTCFullYear()}/${pad(day.getUTCMonth() + 1)}/${pad(day.getUTCDate())}`
  })
}

function isThreadRollout(fileName: string, threadId: string): boolean {
  const lower = fileName.toLowerCase()
  const suffix = `-${threadId.toLowerCase()}.jsonl`
  return lower.startsWith('rollout-') && (lower.endsWith(suffix) || lower.endsWith(`${suffix}.zst`))
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw new CodexHistoryUnreadableError(error)
  }
}

/** The thread's `YYYY/MM/DD/rollout-*.jsonl` tail, or null when no home has ever saved it. */
export async function findThreadRelativePath(
  threadId: string,
  homes: readonly string[]
): Promise<string | null> {
  const cached = relativePaths.get(threadId)
  if (cached) {
    return cached
  }
  const remember = (fileName: string, day: string): string => {
    const relativePath = `${day}/${fileName.replace(/\.zst$/, '')}`
    relativePaths.set(threadId, relativePath)
    return relativePath
  }
  for (const day of threadCreationDays(threadId)) {
    for (const home of homes) {
      const name = (await readDirectoryNames(join(home, 'sessions', day))).find((entry) =>
        isThreadRollout(entry, threadId)
      )
      if (name) {
        return remember(name, day)
      }
    }
  }
  for (const home of homes) {
    // Archived rollouts sit flat; the name's own date gives the dated folder they came from.
    const name = (await readDirectoryNames(join(home, 'archived_sessions'))).find((entry) =>
      isThreadRollout(entry, threadId)
    )
    const day = name ? /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(name) : null
    if (name && day) {
      return remember(name, `${day[1]}/${day[2]}/${day[3]}`)
    }
  }
  // Older thread ids carry no date; walk each home once and remember the answer.
  for (const home of homes) {
    const sessionsRoot = join(home, 'sessions')
    for await (const filePath of listCodexSessionRolloutFilesIncrementally(
      sessionsRoot,
      { batchSize: 64, yieldMs: 0 },
      (_directory, error) => {
        if (!isDefinitiveAbsence(error)) {
          throw new CodexHistoryUnreadableError(error)
        }
      }
    )) {
      if (isThreadRollout(basename(filePath), threadId)) {
        const relativePath = codexDatedRolloutRelativePath(sessionsRoot, filePath)
        if (relativePath) {
          const plain = relativePath.replace(/\.zst$/, '')
          relativePaths.set(threadId, plain)
          return plain
        }
      }
    }
  }
  return null
}

export async function readCopiesInHome(
  home: string,
  relativePlainPath: string
): Promise<ThreadCopy[]> {
  const copies: ThreadCopy[] = []
  for (const path of threadCopyPaths(home, relativePlainPath)) {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new CodexHistoryConflictError(`A non-file occupies a Codex rollout path: ${path}`)
      }
      copies.push({
        path,
        compressed: path.endsWith('.zst'),
        symlink: stat.isSymbolicLink(),
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size
      })
    } catch (error) {
      if (error instanceof CodexHistoryConflictError) {
        throw error
      }
      if (!isDefinitiveAbsence(error)) {
        throw new CodexHistoryUnreadableError(error)
      }
    }
  }
  return copies
}

export async function resolveRegularCopies(copies: ThreadCopy[]): Promise<ThreadCopy[]> {
  const regular: ThreadCopy[] = []
  for (const copy of copies) {
    if (!copy.symlink) {
      regular.push(copy)
      continue
    }
    // A bridged symlink names a copy in another home, which is already a candidate when trusted.
    let target: string
    try {
      target = await realpath(copy.path)
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        continue
      }
      throw new CodexHistoryUnreadableError(error)
    }
    const stat = await lstat(target).catch((error: unknown) => {
      throw new CodexHistoryUnreadableError(error)
    })
    regular.push({
      ...copy,
      path: target,
      symlink: false,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size
    })
  }
  return regular
}
