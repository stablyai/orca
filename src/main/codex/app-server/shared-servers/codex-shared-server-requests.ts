import { codexFrameThreadId, codexSharedFrameParams, field } from './codex-shared-server-frames'
import type { CodexSharedServerFrame } from './codex-shared-server-frames'
import type { CodexSharedServerLease } from './codex-shared-server-lease'

type RequestFrame = Extract<CodexSharedServerFrame, { kind: 'request' }>
type RequestId = number | string

/** Ids Codex no longer owes an answer for, for the server process's life. Codex numbers them in
 *  order, so numeric ids are kept as ranges; any other id is kept as itself. */
class SettledRequestIds {
  /** Sorted, disjoint [from, to] ranges. */
  private ranges: [number, number][] = []
  private readonly others = new Set<string>()

  has(id: RequestId): boolean {
    if (typeof id !== 'number') {
      return this.others.has(id)
    }
    return this.ranges.some(([from, to]) => id >= from && id <= to)
  }

  add(id: RequestId): void {
    if (typeof id !== 'number') {
      this.others.add(id)
      return
    }
    const last = this.ranges.at(-1)
    if (last && id === last[1] + 1) {
      // Answers mostly arrive in order, so the newest range grows in place.
      last[1] = id
      return
    }
    if (this.has(id)) {
      return
    }
    const added: [number, number] = [id, id]
    const ranges = [...this.ranges, added].sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const range of ranges) {
      const last = merged.at(-1)
      if (last && range[0] <= last[1] + 1) {
        last[1] = Math.max(last[1], range[1])
      } else {
        merged.push([range[0], range[1]])
      }
    }
    this.ranges = merged
  }
}

type Pending = { frame: RequestFrame; threadId: string | null; to: CodexSharedServerLease | null }

function keyOf(id: RequestId): string {
  return `${typeof id}:${id}`
}

/**
 * Every request a relayed shared server is owed an answer for. A request for a thread no chat here
 * holds waits, never refused: the chat that later claims the thread gets it, and a chat that leaves
 * without answering hands it back. Codex replays a thread's pending requests on resume and the
 * daemon re-sends them at attach, so a copy of one already held or settled is dropped; each id is
 * answered at most once.
 */
export class CodexSharedServerRequests {
  private readonly pending = new Map<string, Pending>()
  private readonly settled = new SettledRequestIds()

  /** False for a copy: already held here, answered, or resolved. */
  admit(frame: RequestFrame): boolean {
    const { id } = frame.request
    if (this.settled.has(id) || this.pending.has(keyOf(id))) {
      return false
    }
    const threadId = codexFrameThreadId(codexSharedFrameParams(frame))
    this.pending.set(keyOf(id), { frame, threadId, to: null })
    return true
  }

  delivered(frame: RequestFrame, lease: CodexSharedServerLease): void {
    const entry = this.pending.get(keyOf(frame.request.id))
    if (entry) {
      entry.to = lease
    }
  }

  /** The unclaimed requests of a thread a chat just claimed, oldest first. */
  takeFor(threadId: string): RequestFrame[] {
    return [...this.pending.values()]
      .filter((entry) => entry.to === null && entry.threadId === threadId)
      .map((entry) => entry.frame)
  }

  /** A request a chat was handed but can't answer (it left, or is leaving) waits again; false for
   *  one no later chat could take (server-wide, or its thread retired). */
  unclaim(frame: RequestFrame, retired: (threadId: string) => boolean): boolean {
    const entry = this.pending.get(keyOf(frame.request.id))
    if (!entry || entry.threadId === null || retired(entry.threadId)) {
      return false
    }
    entry.to = null
    return true
  }

  /** The chat left stopping nothing: every request it was handed and didn't answer waits again. */
  returned(lease: CodexSharedServerLease): void {
    for (const entry of this.pending.values()) {
      if (entry.to === lease) {
        entry.to = null
      }
    }
  }

  /** True the first time: an answer is sent at most once per id. */
  answer(id: RequestId): boolean {
    if (this.settled.has(id)) {
      return false
    }
    this.settled.add(id)
    this.pending.delete(keyOf(id))
    return true
  }

  /** Codex no longer waits on it (`serverRequest/resolved`). */
  resolved(params: unknown): void {
    const id = field(params, 'requestId')
    if (typeof id === 'number' || typeof id === 'string') {
      this.settled.add(id)
      this.pending.delete(keyOf(id))
    }
  }

  clear(): void {
    this.pending.clear()
  }
}
