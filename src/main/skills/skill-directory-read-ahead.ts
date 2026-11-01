import type { Dirent } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'

// Under a busy event loop each turn finishes at most this many reads, so it sets throughput.
export const MAX_IN_FLIGHT_DIRECTORY_READS = 64
// Finished listings the walk has not claimed yet; bounds memory on wide trees.
export const MAX_UNCLAIMED_DIRECTORY_READS = 512

export type DirectoryRead = { resolvedPath: string | null; entries: Dirent[] | null }

/** A directory's place in the walk: entry indexes from the root. Lexical order is walk order. */
export type WalkOrder = readonly number[]

type Ticket = {
  dirPath: string
  order: WalkOrder
  /** Known for a plain child of a resolved directory: no symlink can change it. */
  resolvedPath: string | null
  started: Promise<DirectoryRead> | null
  dropped: boolean
}

function compareWalkOrder(left: WalkOrder, right: WalkOrder): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index]
    }
  }
  return left.length - right.length
}

/** Min-heap by walk order, so the read the walk needs soonest starts first. */
class TicketHeap {
  private readonly items: Ticket[] = []

  get size(): number {
    return this.items.length
  }

  push(ticket: Ticket): void {
    const items = this.items
    items.push(ticket)
    let index = items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (compareWalkOrder(items[parent].order, ticket.order) <= 0) {
        break
      }
      items[index] = items[parent]
      index = parent
    }
    items[index] = ticket
  }

  pop(): Ticket | undefined {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (items.length === 0 || last === undefined) {
      return top
    }
    let index = 0
    for (;;) {
      const left = index * 2 + 1
      if (left >= items.length) {
        break
      }
      const right = left + 1
      const child =
        right < items.length && compareWalkOrder(items[right].order, items[left].order) < 0
          ? right
          : left
      if (compareWalkOrder(last.order, items[child].order) <= 0) {
        break
      }
      items[index] = items[child]
      index = child
    }
    items[index] = last
    return top
  }
}

async function readDirectory(ticket: Ticket): Promise<DirectoryRead> {
  const [resolvedPath, entries] = await Promise.all([
    ticket.resolvedPath ?? realpath(ticket.dirPath).catch(() => null),
    readdir(ticket.dirPath, { withFileTypes: true }).catch(() => null)
  ])
  return { resolvedPath, entries }
}

export type DirectoryReadAhead = {
  /** The listing the walk needs now; a read started ahead is reused. */
  claim: (dirPath: string, order: WalkOrder) => Promise<DirectoryRead>
  /** The walk will not enter this directory's children; stop reading them ahead. */
  drop: (dirPath: string) => void
}

/**
 * Reads a directory tree ahead of a depth-first walk, in the order the walk will claim it. A busy event loop then costs one turn per batch of reads instead of one per directory. The walk still claims listings in its own order, so its results and cycle guards are unchanged.
 */
export function createDirectoryReadAhead(args: {
  signal?: AbortSignal
  /** Entry indexes of the plain child directories the walk will enter. */
  enteredChildIndexes: (dirPath: string, entries: readonly Dirent[]) => number[]
}): DirectoryReadAhead {
  const { signal, enteredChildIndexes } = args
  const tickets = new Map<string, Ticket>()
  const queue = new TicketHeap()
  let inFlight = 0
  let unclaimed = 0

  function start(ticket: Ticket): Promise<DirectoryRead> {
    inFlight += 1
    const started = readDirectory(ticket).then((read) => {
      inFlight -= 1
      if (read.entries && !ticket.dropped && !signal?.aborted) {
        queueChildren(ticket, read)
      }
      pump()
      return read
    })
    ticket.started = started
    return started
  }

  function queueChildren(parent: Ticket, read: DirectoryRead): void {
    const entries = read.entries ?? []
    for (const index of enteredChildIndexes(parent.dirPath, entries)) {
      const name = entries[index].name
      const ticket: Ticket = {
        dirPath: join(parent.dirPath, name),
        order: [...parent.order, index],
        resolvedPath: read.resolvedPath === null ? null : join(read.resolvedPath, name),
        started: null,
        dropped: false
      }
      tickets.set(ticket.dirPath, ticket)
      queue.push(ticket)
    }
  }

  function pump(): void {
    while (
      !signal?.aborted &&
      inFlight < MAX_IN_FLIGHT_DIRECTORY_READS &&
      unclaimed < MAX_UNCLAIMED_DIRECTORY_READS &&
      queue.size > 0
    ) {
      const ticket = queue.pop()
      if (ticket && !ticket.started && !ticket.dropped) {
        unclaimed += 1
        void start(ticket)
      }
    }
  }

  return {
    claim: (dirPath, order) => {
      const ticket = tickets.get(dirPath)
      tickets.delete(dirPath)
      if (ticket?.started) {
        unclaimed -= 1
        pump()
        return ticket.started
      }
      // Not read yet: start it now rather than wait behind reads the walk needs later.
      return start(ticket ?? { dirPath, order, resolvedPath: null, started: null, dropped: false })
    },
    drop: (dirPath) => {
      const prefix = dirPath.endsWith(sep) ? dirPath : `${dirPath}${sep}`
      for (const [path, ticket] of tickets) {
        if (!path.startsWith(prefix)) {
          continue
        }
        ticket.dropped = true
        tickets.delete(path)
        if (ticket.started) {
          unclaimed -= 1
        }
      }
      pump()
    }
  }
}
