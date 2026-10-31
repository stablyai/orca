import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { HistoryDirectory } from '../../shared/history-filesystem'
import { runFileOperationWithWindowsRetry } from '../../shared/windows-retry-file-operations'

export const HISTORY = 'history.jsonl'
// A private directory holding one claimed entry under HISTORY and that entry's merge cursor.
export const CLAIM = `${HISTORY}.orca-profile-claim-`
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

/** A copy waiting to be merged into the shared file, with its merge cursor. */
export type Pending = {
  /** Undefined once another setup retired or consumed it. */
  read(): Buffer | undefined
  cursor(length: number): number | undefined
  advance(length: number): void
  retire(): void
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

// Retain the copy until a later drain finds no appends from handles opened before the swap.
export function drainHistory(pending: Pending, destination: string, shared: Set<string>): void {
  const content = pending.read()
  if (!content) {
    pending.retire()
    return
  }
  const offset = pending.cursor(content.length)
  if (offset === content.length) {
    pending.retire()
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
  // Advance after append so interrupted drains replay safely through deduplication.
  pending.advance(content.length)
}

// Copies under the old names stay where older builds recover them, and their cursors keep the
// meaning older builds gave them.
export function legacyPending(path: string): Pending {
  const cursor = `${path}.offset`
  return {
    read: () => readFileSync(path),
    cursor: (length) => {
      try {
        return validCursor(readFileSync(cursor, 'utf8'), length)
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          throw error
        }
        return undefined
      }
    },
    advance: (length) => writeFileSync(cursor, `${length}\n`, { mode: 0o600 }),
    retire: () => {
      // Delete the cursor first so an interrupted cleanup safely replays deduplicated lines.
      unlinkSync(cursor)
      unlinkSync(path)
    }
  }
}

// A claim's slot is filled once, by its creator, and never refilled, so anything done through
// its handle reaches that entry or nothing, even after the claim's name is reused.
export function claimPending(parent: HistoryDirectory, claim: Claim): Pending {
  const { directory, name } = claim
  // Fixed width: rewriting in place never leaves a shorter value behind.
  const write = (length: number, create: boolean) =>
    directory.write(CURSOR, `${String(length).padStart(20, '0')}\n`, create)
  return {
    read: () => absentAs(() => directory.read(HISTORY), undefined),
    cursor: (length) =>
      validCursor(
        absentAs(() => directory.read(CURSOR).toString('utf8'), undefined),
        length
      ),
    advance: (length) => {
      try {
        write(length, false)
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) {
          throw error
        }
        // A retired claim refuses creation once its directory is gone; an emptied one is retired again.
        absentAs(() => write(length, true), undefined)
      }
    },
    retire: () => {
      absentAs(() => directory.unlink(HISTORY), undefined)
      // Whoever removes the cursor removes the claim; one without a cursor may still be filling.
      const removed = absentAs(() => {
        directory.unlink(CURSOR)
        return true
      }, false)
      if (removed) {
        removeClaim(parent, name)
      }
    }
  }
}

export type Claim = { name: string; directory: HistoryDirectory }

function removeClaim(parent: HistoryDirectory, name: string): void {
  try {
    parent.removeEmpty(name)
  } catch (error) {
    // A late cursor or a delete-pending entry keeps it for the next setup.
    if (!['ENOENT', 'ENOTEMPTY', 'EBUSY'].some((code) => hasCode(error, code))) {
      throw error
    }
  }
}

// Only its creator removes a claim before it has a cursor, so the name opens the directory just made.
function claim(parent: HistoryDirectory, entry: string): Claim | undefined {
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
 * Claims `entry`, then removes it only if `proved` holds for the claimed entry itself;
 * otherwise puts it back exclusively, or keeps it claimed when its place was taken.
 */
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
    const retired = proved(claimed.directory)
    if (retired) {
      claimed.directory.unlink(HISTORY)
    } else if (
      runFileOperationWithWindowsRetry(() => claimed.directory.move(HISTORY, parent, entry)) !==
      'moved'
    ) {
      return 'kept'
    }
    removeClaim(parent, claimed.name)
    return retired ? 'retired' : 'restored'
  } finally {
    claimed.directory.close()
  }
}
