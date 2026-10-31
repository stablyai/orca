import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryDirectory } from '../../shared/history-filesystem'
import { runFileOperationWithWindowsRetry } from '../../shared/windows-retry-file-operations'
import {
  ClaudeProfileSurfaceError,
  warnClaudeProfile,
  type ClaudeProfileReport
} from './claude-profile-report'

export const HISTORY = 'history.jsonl'
export const CLAUDE_PROFILE_MERGE_SUFFIX = '.orca-profile-merge'
const PENDING = `${HISTORY}${CLAUDE_PROFILE_MERGE_SUFFIX}`
// A private directory holding one claimed entry under HISTORY and that entry's merge cursor.
export const CLAIM = `${HISTORY}.orca-profile-claim-`
export const CONFLICT = `${HISTORY}.orca-profile-conflict`
const CURSOR = 'offset'

function appendHistory(destination: string, lines: string[]): void {
  if (lines.length === 0) {
    return
  }
  const size = statSync(destination).size
  let separator = false
  if (size > 0) {
    const fd = openSync(destination, 'r')
    try {
      const tail = Buffer.alloc(1)
      readSync(fd, tail, 0, 1, size - 1)
      separator = tail[0] !== 10
    } finally {
      closeSync(fd)
    }
  }
  // Terminate records so Claude's next append starts on its own line.
  appendFileSync(destination, `${separator ? '\n' : ''}${lines.join('\n')}\n`)
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export function absentAs<T>(run: () => T, absent: T): T {
  try {
    return run()
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return absent
    }
    throw error
  }
}

function validCursor(text: string | undefined, length: number): number | undefined {
  const stored = Number(text)
  return Number.isSafeInteger(stored) && stored >= 0 && stored <= length ? stored : undefined
}

// A claim's slot is filled once, by its creator, and never refilled, so anything done through
// its handle reaches that entry or nothing, even after the claim's name is reused. Seeing the
// entry is therefore lasting; seeing the slot empty is not, since its creator may still fill it.
export type Claim = { name: string; directory: HistoryDirectory }

function removeClaim(parent: HistoryDirectory, name: string): void {
  try {
    parent.removeEmpty(name)
  } catch (error) {
    // A late cursor, an entry or a delete-pending directory keeps it for the next setup.
    if (!['ENOENT', 'ENOTEMPTY', 'EBUSY'].some((code) => hasCode(error, code))) {
      throw error
    }
  }
}

/** Only for a claim whose entry this setup read, proved or moved in itself. */
export function retireClaim(parent: HistoryDirectory, claimed: Claim): void {
  absentAs(
    () => runFileOperationWithWindowsRetry(() => claimed.directory.unlink(HISTORY)),
    undefined
  )
  absentAs(() => claimed.directory.unlink(CURSOR), undefined)
  removeClaim(parent, claimed.name)
}

// Retain the copy until a later drain finds no appends from handles opened before the swap.
export function drainClaim(
  parent: HistoryDirectory,
  claimed: Claim,
  destination: string,
  shared: Set<string>
): void {
  const { directory } = claimed
  // Only a drain that read the entry writes a cursor, so one read before an empty slot proves
  // the slot was filled and emptied for good.
  const stored = absentAs(() => directory.read(CURSOR).toString('utf8'), undefined)
  const content = absentAs(() => directory.read(HISTORY), undefined)
  if (!content) {
    // An empty slot never authorizes removing the slot; only its creator removes it before a cursor.
    if (stored !== undefined) {
      absentAs(() => directory.unlink(CURSOR), undefined)
      removeClaim(parent, claimed.name)
    }
    return
  }
  const offset = validCursor(stored, content.length)
  if (offset === content.length) {
    retireClaim(parent, claimed)
    return
  }
  // CLI rewrites can replay shared lines; append only missing ones.
  const lines = content
    .subarray(offset ?? 0)
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '' && !shared.has(line))
  appendHistory(destination, lines)
  for (const line of lines) {
    shared.add(line)
  }
  // Advance after append so interrupted drains replay safely through deduplication. Fixed width:
  // rewriting in place never leaves a shorter value behind.
  const cursor = `${String(content.length).padStart(20, '0')}\n`
  try {
    directory.write(CURSOR, cursor, false)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error
    }
    // A retired claim refuses creation once its directory is gone; an emptied one is retired again.
    absentAs(() => directory.write(CURSOR, cursor, true), undefined)
  }
}

/** Moves `entry` into a new claim; undefined when it is gone. */
export function claim(parent: HistoryDirectory, entry: string): Claim | undefined {
  let name: string
  for (let attempt = 0; ; attempt++) {
    name = `${CLAIM}${randomBytes(8).toString('hex')}`
    try {
      parent.mkdir(name)
      break
    } catch (error) {
      if (!hasCode(error, 'EEXIST') || attempt === 3) {
        throw error
      }
    }
  }
  // No other setup removes a claim before it has a cursor, so the name opens the directory just made.
  const directory = parent.open(name)
  try {
    if (
      runFileOperationWithWindowsRetry(() => parent.move(entry, directory, HISTORY)) === 'moved'
    ) {
      return { name, directory }
    }
  } catch (error) {
    directory.close()
    removeClaim(parent, name)
    throw error
  }
  directory.close()
  removeClaim(parent, name)
  return undefined
}

/**
 * Settles a claim this setup filled: removes its entry only if `proved` holds for that entry,
 * otherwise puts it back at `entry` exclusively, or keeps it claimed when that place was taken.
 */
export function settleClaim(
  parent: HistoryDirectory,
  claimed: Claim,
  entry: string,
  proved: (directory: HistoryDirectory) => boolean
): 'retired' | 'restored' | 'kept' | 'missing' {
  let result: 'retired' | 'restored' | 'missing'
  if (proved(claimed.directory)) {
    // Another setup may have retired the proved entry first.
    result = absentAs<'retired' | 'missing'>(() => {
      runFileOperationWithWindowsRetry(() => claimed.directory.unlink(HISTORY))
      return 'retired'
    }, 'missing')
  } else {
    const moved = runFileOperationWithWindowsRetry(() =>
      claimed.directory.move(HISTORY, parent, entry)
    )
    if (moved === 'collision') {
      return 'kept'
    }
    result = moved === 'moved' ? 'restored' : 'missing'
  }
  removeClaim(parent, claimed.name)
  return result
}

/** Claims `entry` and settles it at once. */
export function retireProved(
  parent: HistoryDirectory,
  entry: string,
  proved: (claimed: HistoryDirectory) => boolean
): 'retired' | 'restored' | 'kept' | 'missing' {
  const claimed = claim(parent, entry)
  if (!claimed) {
    return 'missing'
  }
  try {
    return settleClaim(parent, claimed, entry, proved)
  } finally {
    claimed.directory.close()
  }
}

/** Moves `entry` to the first free `base` generation; an occupied one is never replaced. */
export function setAside(
  parent: HistoryDirectory,
  entry: string,
  base: string
): string | undefined {
  for (let generation = 0; ; generation++) {
    const name = generation === 0 ? base : `${base}-${generation}`
    const moved = runFileOperationWithWindowsRetry(() => parent.move(entry, parent, name))
    if (moved !== 'collision') {
      return moved === 'moved' ? name : undefined
    }
  }
}

// Copies under the old names come from older builds, and any copy that ever had a name could
// have written the progress marker beside it. A marked copy whose every line is already shared
// (an older build's drained leftover) is retired, which loses and brings back nothing; its marker
// goes with the next setup. Otherwise importing it could bring back prompts the user deleted and
// retiring it could lose prompts never imported, so it is kept aside unimported. An unmarked copy
// is claimed and merged like a new one.
export function legacyPending(
  parent: HistoryDirectory,
  name: string,
  marked: boolean,
  shared: Set<string>
): Claim | { keptAt: string } | undefined {
  if (!marked) {
    return claim(parent, name)
  }
  const merged = (directory: HistoryDirectory, entry: string): boolean =>
    absentAs(() => directory.read(entry).toString('utf8'), '')
      .split('\n')
      .every((line) => line === '' || shared.has(line))
  // Proved again through the claim, since the name may hold a newer copy by then.
  if (
    merged(parent, name) &&
    retireProved(parent, name, (claimed) => merged(claimed, HISTORY)) !== 'restored'
  ) {
    return undefined
  }
  const keptAt = setAside(parent, name, CONFLICT)
  return keptAt ? { keptAt } : undefined
}

function pendingGeneration(name: string): number | null {
  if (name === PENDING) {
    return 0
  }
  const suffix = name.slice(PENDING.length + 1)
  return name.startsWith(`${PENDING}-`) && /^\d+$/.test(suffix) ? Number(suffix) : null
}

export type Proof = (directory: HistoryDirectory, name: string) => boolean

// One bounded pass: drain surviving copies, and retire what is proved redundant (a moved-aside
// publication, a cursor whose copy is gone). Unknown entries and retained originals stay.
export function recoverPending(
  parent: HistoryDirectory,
  isPublication: Proof,
  report: ClaudeProfileReport
): { legacy: { name: string; marked: boolean }[]; claims: string[] } {
  const names = new Set(parent.entries())
  const legacy: { name: string; marked: boolean; generation: number }[] = []
  const claims: string[] = []
  for (const name of names) {
    const generation = pendingGeneration(name)
    const copy = name.endsWith('.offset') ? name.slice(0, -'.offset'.length) : undefined
    try {
      if (generation !== null) {
        if (isPublication(parent, name)) {
          retireProved(parent, name, (claimed) => isPublication(claimed, HISTORY))
        } else if (parent.kind(name) === 'file') {
          legacy.push({ name, marked: names.has(`${name}.offset`), generation })
        }
      } else if (name.startsWith(CLAIM) && parent.kind(name) === 'directory') {
        claims.push(name)
      } else if (copy && pendingGeneration(copy) !== null && !names.has(copy)) {
        // Left by a drain that finished after another retired its copy; a new copy under that
        // name must not inherit it.
        if (parent.kind(name) === 'file') {
          absentAs(() => parent.unlink(name), undefined)
        }
      }
    } catch (error) {
      warnClaudeProfile(report, HISTORY, error)
    }
  }
  // Directory enumeration order does not preserve prompt chronology.
  legacy.sort((left, right) => left.generation - right.generation)
  return { legacy, claims }
}

/** Merges what `recoverPending` found; a failed copy never blocks the others or the link. */
export function drainPending(
  parent: HistoryDirectory,
  { legacy, claims }: ReturnType<typeof recoverPending>,
  profile: string,
  destination: string,
  shared: Set<string>,
  isPublication: Proof,
  report: ClaudeProfileReport
): void {
  for (const { name, marked } of legacy) {
    try {
      const adopted = legacyPending(parent, name, marked, shared)
      if (adopted && 'keptAt' in adopted) {
        const detail = `Prompt history with an unknown merge position is kept at ${join(profile, adopted.keptAt)}`
        warnClaudeProfile(
          report,
          HISTORY,
          new ClaudeProfileSurfaceError('retained-conflict', detail)
        )
      } else if (adopted) {
        try {
          drainClaim(parent, adopted, destination, shared)
        } finally {
          adopted.directory.close()
        }
      }
    } catch (error) {
      // A failed drain must not prevent linking the profile.
      warnClaudeProfile(report, HISTORY, error)
    }
  }
  for (const name of claims) {
    try {
      const claimed = { name, directory: parent.open(name) }
      try {
        const kind = claimed.directory.kind(HISTORY)
        if (isPublication(claimed.directory, HISTORY)) {
          retireClaim(parent, claimed)
        } else if (kind === 'file' || kind === null) {
          drainClaim(parent, claimed, destination, shared)
        }
        // A link or directory claimed from H stays; the setup that claimed it reported where.
      } finally {
        claimed.directory.close()
      }
    } catch (error) {
      warnClaudeProfile(report, HISTORY, error)
    }
  }
}
