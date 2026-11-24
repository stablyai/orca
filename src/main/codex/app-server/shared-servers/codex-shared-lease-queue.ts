import { codexSharedFrameParams, type CodexSharedServerFrame } from './codex-shared-server-frames'

/** A paused chat that resumes replays this much of its queue per task, then yields, as a pipe
 *  read would. */
const DRAIN_CHUNK_BYTES = 64 * 1024

type QueueOwner = {
  /** Reading and not ended: frames may go to the chat now. */
  canDispatch: () => boolean
  dispatch: (frame: CodexSharedServerFrame) => void
  /** The queue grew or shrank by these bytes. */
  backlog: (deltaBytes: number) => void
  /** Answers a request the chat will never see. */
  refuse: (frame: CodexSharedServerFrame) => void
}

/** One chat's frames held while it is paused or catching up, in arrival order. */
export class CodexSharedLeaseQueue {
  /** Drained slots are emptied at once, so a paused replay holds no frame it already sent. */
  private frames: ({ frame: CodexSharedServerFrame; bytes: number } | null)[] = []
  /** Next frame to dispatch; drained slots are dropped once they are half the array, so a long
   *  drain stays linear. */
  private head = 0
  private heldBytes = 0
  private draining = false
  private scheduled = false

  constructor(private readonly owner: QueueOwner) {}

  get bytes(): number {
    return this.heldBytes
  }

  get pending(): number {
    return this.frames.length - this.head
  }

  /** Holds a frame; returns how many are now held. */
  push(frame: CodexSharedServerFrame): number {
    const bytes = Buffer.byteLength(JSON.stringify(codexSharedFrameParams(frame) ?? null), 'utf8')
    this.frames.push({ frame, bytes })
    this.heldBytes += bytes
    this.owner.backlog(bytes)
    return this.pending
  }

  /** Drops every held frame; held requests are refused so Codex doesn't wait on them. */
  drop(): void {
    for (const slot of this.frames.slice(this.head)) {
      if (slot?.frame.kind === 'request') {
        this.owner.refuse(slot.frame)
      }
    }
    this.owner.backlog(-this.heldBytes)
    this.frames = []
    this.head = 0
    this.heldBytes = 0
  }

  drain(): void {
    if (this.draining) {
      return
    }
    this.draining = true
    let budget = DRAIN_CHUNK_BYTES
    let drained = 0
    try {
      while (budget > 0 && this.pending > 0 && this.owner.canDispatch()) {
        const { frame, bytes } = this.frames[this.head]!
        this.frames[this.head] = null
        this.head += 1
        this.heldBytes -= bytes
        budget -= bytes
        drained += bytes
        this.owner.dispatch(frame)
      }
    } finally {
      // One report per batch: the server's backlog weighs every chat on each report.
      if (drained > 0) {
        this.owner.backlog(-drained)
      }
      if (this.head * 2 >= this.frames.length) {
        this.frames.splice(0, this.head)
        this.head = 0
      }
      this.draining = false
    }
    if (!this.scheduled && this.pending > 0 && this.owner.canDispatch()) {
      this.scheduled = true
      setImmediate(() => {
        this.scheduled = false
        this.drain()
      })
    }
  }
}
