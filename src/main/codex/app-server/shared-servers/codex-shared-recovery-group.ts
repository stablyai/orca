import { codexSharedFrameParams, type CodexSharedServerFrame } from './codex-shared-server-frames'
import type { CodexRecoveryHeld } from './codex-shared-recovery-seq-floor'

/** A chat whose run a reattached server still carries: its own thread, and its commands' tag. */
export type CodexRecoveredChat = { sessionId: string; threadId: string; workload: string }

/** One chat's threads (or, unowned, one unresolved root's) and their frames in arrival order. */
export class RecoveryGroup {
  /** Thread → its parent, in discovery order; the root's parent is null. */
  readonly threads = new Map<string, string | null>()
  frames: CodexRecoveryHeld[] = []
  bytes = 0
  /** Bytes of its frames that may be dropped (all but requests). */
  droppable = 0
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

export const recoveryFrameBytes = (frame: CodexSharedServerFrame): number =>
  Buffer.byteLength(JSON.stringify(codexSharedFrameParams(frame) ?? null), 'utf8')

/** What a chat takes over, or what an unwanted group lets go. */
export type CodexRecoveredGroup = {
  chat: CodexRecoveredChat | null
  /** [thread, parent], parents first. */
  threads: [string, string | null][]
  frames: CodexSharedServerFrame[]
  cut: boolean
}

/** What a server handed back to its daemon keeps of its recovery, for the next attach. */
export type CodexRecoveryKept = {
  groups: { chat: CodexRecoveredChat | null; threads: [string, string | null][]; cut: boolean }[]
  cutEverything: boolean
}

/** The group `size` ranks largest (above zero), or null. */
export function largestRecoveryGroup(
  among: Iterable<RecoveryGroup>,
  size: (group: RecoveryGroup) => number
): RecoveryGroup | null {
  let best: RecoveryGroup | null = null
  let bestSize = 0
  for (const group of among) {
    const value = size(group)
    if (value > bestSize) {
      best = group
      bestSize = value
    }
  }
  return best
}
