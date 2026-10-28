import { CodexAppliedSettings } from './codex-structured-applied-settings'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'

// Bound events retained before a session can route them.
export const MAX_CODEX_ACQUISITION_BUFFER_OPERATIONS = 1024
export const MAX_CODEX_ACQUISITION_BUFFER_BYTES = 4 * 1024 * 1024

export class CodexAcquisitionWindow {
  readonly appliedSettings = new CodexAppliedSettings()
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

  /** False means the buffer closed or overflowed; only published sessions may deliver live. */
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

  drain(): (() => void)[] {
    this.open = false
    this.retainedBytes = 0
    return this.buffered.splice(0)
  }
}
