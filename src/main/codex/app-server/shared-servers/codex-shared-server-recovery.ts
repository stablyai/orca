import { codexSharedFrameParams, type CodexSharedServerFrame } from './codex-shared-server-frames'

/** Thread identities (id and parent link, about 200 bytes each) one server holds for recovery. */
export const CODEX_SHARED_RECOVERY_MAX_IDENTITIES = 4_096

/** A chat whose run a reattached server still carries: its own thread, and its commands' tag. */
export type CodexRecoveredChat = { sessionId: string; threadId: string; workload: string }

type Held = { frame: CodexSharedServerFrame; bytes: number }

/** One chat's threads (or, unowned, one unresolved root's) and their frames in arrival order. */
class RecoveryGroup {
  /** Thread → its parent, in discovery order; the root's parent is null. */
  readonly threads = new Map<string, string | null>()
  frames: Held[] = []
  bytes = 0
  /** Frames were dropped (or descendants collapsed): the chat that claims it gets the cut. */
  cut = false
  /** Its descendants were let go at the identity cap; later ones are no longer tracked. */
  collapsed = false
  /** When its unresolved root was last read; one read per 10 s. */
  readAt = 0

  constructor(
    readonly root: string,
    public chat: CodexRecoveredChat | null
  ) {
    this.threads.set(root, null)
  }
}

/** What a chat takes over, or what an unwanted group lets go. */
export type CodexRecoveredGroup = {
  chat: CodexRecoveredChat | null
  /** [thread, parent], parents first. */
  threads: [string, string | null][]
  frames: CodexSharedServerFrame[]
  cut: boolean
}

const frameBytes = (frame: CodexSharedServerFrame): number =>
  Buffer.byteLength(JSON.stringify(codexSharedFrameParams(frame) ?? null), 'utf8')

/**
 * What a reattached shared server holds for chats that haven't claimed their threads yet: each
 * expected chat's thread and the descendants found under it, and loaded threads whose owner isn't
 * known yet, grouped by their unresolved root. Nothing here expires; bytes and identities are
 * bounded per server, and every drop is recorded as a cut on its group.
 */
export class CodexSharedServerRecovery {
  private readonly groups = new Map<string, RecoveryGroup>()
  private readonly groupOf = new Map<string, RecoveryGroup>()
  private readonly bySession = new Map<string, RecoveryGroup>()
  private heldBytes = 0
  /** The reattach couldn't list every loaded thread: an unknown thread's frames are held too. */
  discoveryPartial = false

  constructor(
    /** Answers a request no chat will take, so Codex doesn't wait on it. */
    private readonly refuse: (frame: CodexSharedServerFrame) => void,
    /** Bytes the server may still hold here (its 32 MiB less what its chats' queues hold). */
    private readonly room: () => number,
    private readonly maxIdentities = CODEX_SHARED_RECOVERY_MAX_IDENTITIES
  ) {}

  get empty(): boolean {
    return this.groups.size === 0
  }

  get bytes(): number {
    return this.heldBytes
  }

  get identities(): number {
    return this.groupOf.size
  }

  holds(threadId: string): boolean {
    return this.groupOf.has(threadId)
  }

  expected(sessionId: string): CodexRecoveredChat | null {
    return this.bySession.get(sessionId)?.chat ?? null
  }

  /** Each expected chat's own thread, and every unresolved root. */
  roots(): { root: string; chat: CodexRecoveredChat | null }[] {
    return [...this.groups.values()].map(({ root, chat }) => ({ root, chat }))
  }

  /** A chat whose record names this server: its thread is held for it until it claims it. */
  expect(chat: CodexRecoveredChat): void {
    const existing = this.groupOf.get(chat.threadId)
    if (existing && existing.root === chat.threadId) {
      existing.chat = chat
      this.bySession.set(chat.sessionId, existing)
      return
    }
    if (existing) {
      return
    }
    const group = new RecoveryGroup(chat.threadId, chat)
    this.add(group)
    this.bySession.set(chat.sessionId, group)
    this.boundIdentities()
  }

  /** Frames this group held were dropped before (a hand-back keeps its claim's cut). */
  markCut(threadId: string): void {
    const group = this.groupOf.get(threadId)
    if (group) {
      group.cut = true
    }
  }

  /** A loaded thread whose owner can't be told yet: a provisional owner of its own group. */
  holdUnowned(threadId: string): void {
    if (!this.groupOf.has(threadId)) {
      this.add(new RecoveryGroup(threadId, null))
      this.boundIdentities()
    }
  }

  /** A child named under a held thread joins that thread's group; false when nothing holds it. */
  join(child: string, parent: string): boolean {
    const group = this.groupOf.get(parent)
    if (!group || group.collapsed) {
      return false
    }
    const current = this.groupOf.get(child)
    if (current === group) {
      return true
    }
    if (current) {
      // An unresolved root turned out to be this parent's child: its whole group follows it.
      if (current.root !== child) {
        return true
      }
      this.merge(current, group, parent)
      return true
    }
    group.threads.set(child, parent)
    this.groupOf.set(child, group)
    this.boundIdentities()
    return true
  }

  hold(threadId: string, frame: CodexSharedServerFrame): boolean {
    if (this.discoveryPartial && !this.groupOf.has(threadId)) {
      this.holdUnowned(threadId)
    }
    const group = this.groupOf.get(threadId)
    if (!group) {
      return false
    }
    const bytes = frameBytes(frame)
    group.frames.push({ frame, bytes })
    group.bytes += bytes
    this.heldBytes += bytes
    this.boundBytes()
    return true
  }

  /** The first held frame's seq, for the relay's ack floor. */
  floor(): number | null {
    let floor: number | null = null
    for (const group of this.groups.values()) {
      const seq = group.frames.find((held) => typeof held.frame.seq === 'number')?.frame.seq
      if (typeof seq === 'number' && (floor === null || seq < floor)) {
        floor = seq
      }
    }
    return floor
  }

  /** The whole group holding this thread, for the chat now claiming it (or its owner's chat). */
  take(threadId: string): CodexRecoveredGroup | null {
    const group = this.groupOf.get(threadId)
    return group ? this.remove(group) : null
  }

  /** The chat's record no longer names this server (or it settled gone): its group goes. */
  release(sessionId: string): CodexRecoveredGroup | null {
    const group = this.bySession.get(sessionId)
    return group ? this.remove(group) : null
  }

  /** Unresolved roots due a read again (one per 10 s each), marked read now. */
  dueUnresolved(now = Date.now()): string[] {
    const due: string[] = []
    for (const group of this.groups.values()) {
      if (group.chat === null && now - group.readAt >= 10_000) {
        group.readAt = now
        due.push(group.root)
      }
    }
    return due
  }

  clear(): void {
    for (const group of this.groups.values()) {
      this.drop(this.remove(group))
    }
  }

  /** Refuses the requests of a group nobody will claim. */
  drop(released: CodexRecoveredGroup | null): void {
    for (const frame of released?.frames ?? []) {
      if (frame.kind === 'request') {
        this.refuse(frame)
      }
    }
  }

  private add(group: RecoveryGroup): void {
    this.groups.set(group.root, group)
    this.groupOf.set(group.root, group)
  }

  private remove(group: RecoveryGroup): CodexRecoveredGroup {
    this.groups.delete(group.root)
    for (const threadId of group.threads.keys()) {
      this.groupOf.delete(threadId)
    }
    if (group.chat && this.bySession.get(group.chat.sessionId) === group) {
      this.bySession.delete(group.chat.sessionId)
    }
    this.heldBytes -= group.bytes
    return {
      chat: group.chat,
      threads: [...group.threads],
      frames: group.frames.map((held) => held.frame),
      cut: group.cut
    }
  }

  private merge(from: RecoveryGroup, into: RecoveryGroup, parent: string): void {
    this.groups.delete(from.root)
    for (const [threadId, link] of from.threads) {
      into.threads.set(threadId, threadId === from.root ? parent : link)
      this.groupOf.set(threadId, into)
    }
    // Both lists are in arrival order; their seqs interleave them back into one.
    const seqOf = (held: Held) => held.frame.seq ?? Number.POSITIVE_INFINITY
    into.frames = [...into.frames, ...from.frames].sort((a, b) => seqOf(a) - seqOf(b))
    into.bytes += from.bytes
    into.cut ||= from.cut
  }

  /** Past the bytes the server has left, the largest group's oldest frames go (requests stay),
   *  down to an eighth of the room below it so a steady stream doesn't drop one frame at a time. */
  private boundBytes(): void {
    const room = Math.max(0, this.room())
    let over = this.heldBytes - room
    if (over <= 0) {
      return
    }
    over += room / 8
    while (over > 0) {
      const largest = this.largest((group) => group.bytes)
      if (!largest) {
        return
      }
      let freed = 0
      const kept: Held[] = []
      for (const held of largest.frames) {
        if (freed < over && held.frame.kind !== 'request') {
          freed += held.bytes
        } else {
          kept.push(held)
        }
      }
      if (freed === 0) {
        return
      }
      largest.frames = kept
      largest.bytes -= freed
      this.heldBytes -= freed
      largest.cut = true
      over -= freed
    }
  }

  /** Past the identity cap, the group with the most descendants collapses to its root. */
  private boundIdentities(): void {
    while (this.groupOf.size > this.maxIdentities) {
      const largest = this.largest((group) => group.threads.size - 1)
      if (!largest) {
        return
      }
      const descendants = new Set([...largest.threads.keys()].filter((id) => id !== largest.root))
      for (const threadId of descendants) {
        largest.threads.delete(threadId)
        this.groupOf.delete(threadId)
      }
      const kept: Held[] = []
      for (const held of largest.frames) {
        const owner = threadOf(held.frame)
        if (owner !== null && descendants.has(owner)) {
          largest.bytes -= held.bytes
          this.heldBytes -= held.bytes
          if (held.frame.kind === 'request') {
            this.refuse(held.frame)
          }
        } else {
          kept.push(held)
        }
      }
      largest.frames = kept
      largest.cut = true
      largest.collapsed = true
    }
  }

  private largest(size: (group: RecoveryGroup) => number): RecoveryGroup | null {
    let best: RecoveryGroup | null = null
    let bestSize = 0
    for (const group of this.groups.values()) {
      const value = size(group)
      if (value > bestSize) {
        best = group
        bestSize = value
      }
    }
    return best
  }
}

/** The thread a held frame was routed by (recorded when it was held). */
function threadOf(frame: CodexSharedServerFrame): string | null {
  return frame.threadId ?? null
}
