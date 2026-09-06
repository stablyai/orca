// The gap between spawning `codex app-server` and publishing the session it
// belongs to. Codex talks during that gap — the handshake, an early
// notification, even an approval request — and those events belong to the
// session that is still being acquired, so they wait here instead of arriving
// before anything can route them. The gap is bounded by the thread-open request
// timeout; a failed acquisition discards the buffer along with the child.

import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'

/** Pre-publication buffering is bounded so a provider cannot pin closures. */
export const MAX_CODEX_ACQUISITION_BUFFER_OPERATIONS = 1024
export const MAX_CODEX_ACQUISITION_BUFFER_BYTES = 4 * 1024 * 1024

export class CodexAcquisitionWindow {
  readonly prompts = new CodexPromptRegistry()
  /** Null until the spawn resolves; the handshake can already emit events. */
  connection: CodexAppServerConnection | null = null
  private readonly buffered: (() => void)[] = []
  private retainedBytes = 0
  private open = true
  private overflowed = false

  get isOverflowed(): boolean {
    return this.overflowed
  }

  /** Returns false once the session is published, which is the caller's cue to
   *  deliver live rather than buffer. */
  buffer(event: () => void, retainedBytes = 256): boolean {
    if (!this.open) {
      return false
    }
    const bytes = Number.isFinite(retainedBytes) && retainedBytes > 0 ? Math.ceil(retainedBytes) : 1
    if (
      this.buffered.length >= MAX_CODEX_ACQUISITION_BUFFER_OPERATIONS ||
      this.retainedBytes + bytes > MAX_CODEX_ACQUISITION_BUFFER_BYTES
    ) {
      // Refuse the acquisition rather than dropping an event and continuing.
      this.overflowed = true
      this.open = false
      this.buffered.length = 0
      this.retainedBytes = 0
      return false
    }
    this.buffered.push(event)
    this.retainedBytes += bytes
    return true
  }

  /** Closes the window and hands back what arrived while it was open, in order. */
  drain(): (() => void)[] {
    this.open = false
    this.retainedBytes = 0
    return this.buffered.splice(0)
  }
}
