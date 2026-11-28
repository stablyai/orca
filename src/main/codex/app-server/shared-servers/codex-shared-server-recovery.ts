import type { CodexSharedServerFrame } from './codex-shared-server-frames'
import {
  CodexRecoverySeqFloor,
  type CodexRecoveryHeld as Held
} from './codex-shared-recovery-seq-floor'
import {
  RecoveryGroup,
  largestRecoveryGroup,
  recoveryFrameBytes,
  type CodexRecoveredChat,
  type CodexRecoveredGroup,
  type CodexRecoveryKept
} from './codex-shared-recovery-group'

/** Thread identities (id and parent link, about 200 bytes each) one server holds for recovery. */
export const CODEX_SHARED_RECOVERY_MAX_IDENTITIES = 4_096
/** Dropped past the byte bound beyond what's needed, so a stream never drops one frame per frame. */
const MIN_DROP_HEADROOM_BYTES = 256 * 1024

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
  private readonly seqs = new CodexRecoverySeqFloor()
  /** Groups with frames that may be dropped, so the byte bound visits only those. */
  private readonly droppable = new Set<RecoveryGroup>()
  /** Groups with no chat yet, so a retry never visits the expected ones. */
  private readonly unresolved = new Set<RecoveryGroup>()
  /** An unknown thread's frames were let go at the cap: every chat that claims gets a cut. */
  private cutEverything = false
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

  /** Groups whose owner isn't known yet. */
  get unresolvedCount(): number {
    return this.unresolved.size
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

  /** What a hand-back keeps of it for the next attach: identities and cuts, no frames. */
  kept(): CodexRecoveryKept {
    const groups = [...this.groups.values()].map(({ chat, threads, cut }) => ({
      chat,
      threads: [...threads],
      cut: cut || this.cutEverything
    }))
    return { groups, cutEverything: this.cutEverything }
  }

  /** Every group taken from here on is cut (frames an unknown thread held were let go). */
  cutFromNowOn(): void {
    this.cutEverything = true
  }

  /** The threads held for this chat now, left in place. */
  threadsOf(sessionId: string): string[] {
    return [...(this.bySession.get(sessionId)?.threads.keys() ?? [])]
  }

  /** The family held with this thread, left in place. */
  familyOf(threadId: string): string[] {
    return [...(this.groupOf.get(threadId)?.threads.keys() ?? [])]
  }

  /** A chat whose record names this server: its thread is held for it until it claims it. */
  expect(chat: CodexRecoveredChat): void {
    const existing = this.groupOf.get(chat.threadId)
    if (existing && existing.root === chat.threadId) {
      existing.chat = chat
      this.unresolved.delete(existing)
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
    if (this.groups.size >= this.maxIdentities && !this.groupOf.has(child)) {
      // Roots alone fill the cap: nothing can collapse, so the child isn't tracked and the
      // family that would have held it gets the cut.
      group.cut = true
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
      if (this.identities < this.maxIdentities) {
        this.holdUnowned(threadId)
      } else {
        // Past the cap an unknown thread gets today's unrouted handling; any chat may own it.
        this.cutFromNowOn()
      }
    }
    const group = this.groupOf.get(threadId)
    if (!group) {
      return false
    }
    const held: Held = { frame, bytes: recoveryFrameBytes(frame), gone: false }
    group.frames.push(held)
    group.bytes += held.bytes
    this.heldBytes += held.bytes
    this.seqs.add(held)
    if (frame.kind !== 'request') {
      group.droppable += held.bytes
      this.droppable.add(group)
    }
    this.boundBytes()
    return true
  }

  /** The first held frame's seq, for the relay's ack floor. */
  floor(): number | null {
    return this.seqs.floor()
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
    for (const group of this.unresolved) {
      if (now - group.readAt >= 10_000) {
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
    this.seqs.clear()
    this.cutEverything = false
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
    if (group.chat === null) {
      this.unresolved.add(group)
    }
  }

  private remove(group: RecoveryGroup): CodexRecoveredGroup {
    this.groups.delete(group.root)
    this.droppable.delete(group)
    this.unresolved.delete(group)
    for (const held of group.frames) {
      this.seqs.gone(held)
    }
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
      cut: group.cut || this.cutEverything
    }
  }

  private merge(from: RecoveryGroup, into: RecoveryGroup, parent: string): void {
    this.groups.delete(from.root)
    this.droppable.delete(from)
    this.unresolved.delete(from)
    if (from.droppable > 0) {
      this.droppable.add(into)
    }
    for (const [threadId, link] of from.threads) {
      into.threads.set(threadId, threadId === from.root ? parent : link)
      this.groupOf.set(threadId, into)
    }
    // Both lists are in arrival order; their seqs interleave them back into one.
    const seqOf = (held: Held) => held.frame.seq ?? Number.POSITIVE_INFINITY
    into.frames = [...into.frames, ...from.frames].sort((a, b) => seqOf(a) - seqOf(b))
    into.bytes += from.bytes
    into.droppable += from.droppable
    into.cut ||= from.cut
  }

  /** Past the bytes the server has left, the group with the most droppable bytes loses its oldest
   *  frames (requests stay), down to some headroom so a steady stream doesn't drop frame by frame. */
  private boundBytes(): void {
    const room = Math.max(0, this.room())
    let over = this.heldBytes - room
    if (over <= 0) {
      return
    }
    over += Math.max(room / 8, MIN_DROP_HEADROOM_BYTES)
    // The largest goes first; past it, groups in order, each visited once per overflow.
    const largest = largestRecoveryGroup(this.droppable, (group) => group.droppable)
    over -= largest ? this.dropOldest(largest, over) : 0
    for (const group of this.droppable) {
      if (over <= 0) {
        return
      }
      over -= this.dropOldest(group, over)
    }
  }

  private dropOldest(group: RecoveryGroup, over: number): number {
    let freed = 0
    const kept: Held[] = []
    for (const held of group.frames) {
      if (freed < over && held.frame.kind !== 'request') {
        freed += held.bytes
        this.seqs.gone(held)
      } else {
        kept.push(held)
      }
    }
    if (freed > 0) {
      group.frames = kept
      this.shrink(group, freed, freed)
      group.cut = true
    }
    return freed
  }

  private shrink(group: RecoveryGroup, bytes: number, droppable: number): void {
    group.bytes -= bytes
    group.droppable -= droppable
    this.heldBytes -= bytes
    if (group.droppable <= 0) {
      this.droppable.delete(group)
    }
  }

  /** Past the identity cap, the group with the most descendants collapses to its root. */
  private boundIdentities(): void {
    // Only descendants can collapse; roots are bounded by the chats and the reattach listing.
    while (this.groupOf.size > this.maxIdentities && this.groupOf.size > this.groups.size) {
      const largest = largestRecoveryGroup(this.groups.values(), (group) => group.threads.size - 1)
      if (!largest) {
        return
      }
      const descendants = new Set([...largest.threads.keys()].filter((id) => id !== largest.root))
      for (const threadId of descendants) {
        largest.threads.delete(threadId)
        this.groupOf.delete(threadId)
      }
      const kept: Held[] = []
      let bytes = 0
      let droppable = 0
      for (const held of largest.frames) {
        const owner = held.frame.threadId ?? null
        if (owner !== null && descendants.has(owner)) {
          bytes += held.bytes
          this.seqs.gone(held)
          if (held.frame.kind === 'request') {
            this.refuse(held.frame)
          } else {
            droppable += held.bytes
          }
        } else {
          kept.push(held)
        }
      }
      largest.frames = kept
      this.shrink(largest, bytes, droppable)
      largest.cut = true
      largest.collapsed = true
    }
  }
}
