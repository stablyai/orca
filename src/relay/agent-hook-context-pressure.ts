import { parseClaudeStatusLineContextUsage } from '../shared/claude-statusline-context-window'
import type { RelayHookForward } from './agent-hook-server-contract'

/** Owns the relay's context-pressure master flag and the statusline POST that
 *  feeds it. Remote statusline scripts gate on the endpoint-file flag, so a
 *  flip must republish it. */
export class RelayContextPressure {
  private enabled = false

  get isEnabled(): boolean {
    return this.enabled
  }

  /** Flips the flag and republishes the endpoint file; the publish itself
   *  no-ops when the server is not listening, so no live-check is needed. */
  setEnabled(enabled: boolean, republishEndpoint: () => void): void {
    if (this.enabled === enabled) {
      return
    }
    this.enabled = enabled
    republishEndpoint()
  }

  /** Forwards a parsed statusline reading as a context-usage envelope; silently
   *  no-ops while tracking is disabled or the body is not a reading. */
  handleClaudeStatusline(body: unknown, forward: RelayHookForward): void {
    const reading = this.enabled ? parseClaudeStatusLineContextUsage(body) : null
    if (!reading) {
      return
    }
    forward({
      source: 'claude',
      paneKey: reading.paneKey,
      connectionId: null,
      contextUsage: reading.usage,
      contextSessionId: reading.sessionId
    })
  }
}
