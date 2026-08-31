// The gap between spawning `codex app-server` and publishing the session it
// belongs to. Codex talks during that gap — the handshake, an early
// notification, even an approval request — and those events belong to the
// session that is still being acquired, so they wait here instead of arriving
// before anything can route them. The gap is bounded by the thread-open request
// timeout; a failed acquisition discards the buffer along with the child.

import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'

export class CodexAcquisitionWindow {
  readonly prompts = new CodexPromptRegistry()
  /** Null until the spawn resolves; the handshake can already emit events. */
  connection: CodexAppServerConnection | null = null
  private readonly buffered: (() => void)[] = []
  private open = true

  /** Returns false once the session is published, which is the caller's cue to
   *  deliver live rather than buffer. */
  buffer(event: () => void): boolean {
    if (!this.open) {
      return false
    }
    this.buffered.push(event)
    return true
  }

  /** Closes the window and hands back what arrived while it was open, in order. */
  drain(): (() => void)[] {
    this.open = false
    return this.buffered.splice(0)
  }
}
