import { codexReplayLeftTranscriptWork } from '../../../shared/agent-hook-listener/providers/codex/codex-state'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerStatusRetries } from './server-status-retries'

export abstract class AgentHookServerReplayTranscriptPolls extends AgentHookServerStatusRetries {
  /** Replay drains before the server binds, and a poll that runs then is dropped, so these wait for it to listen. */
  protected requestReplayTranscriptPoll(
    source: AgentHookSource,
    paneKey: string,
    body: unknown,
    original?: EnrichedAgentHookEventPayload
  ): void {
    // Replayed agy child hooks change pane state without a row, so they re-arm like ignored hooks.
    const key = original?.paneKey ?? paneKey
    const codex = source === 'codex' && original && codexReplayLeftTranscriptWork(this.state, key)
    if (source === 'antigravity' || codex) {
      this.replayTranscriptPolls.set(key, {
        source,
        body,
        original: codex ? original : undefined
      })
    }
    if (this.server) {
      this.scheduleReplayTranscriptPolls()
    }
  }

  protected scheduleReplayTranscriptPolls(): void {
    for (const { source, body, original } of this.replayTranscriptPolls.values()) {
      if (original) {
        this.scheduleTranscriptPoll(source, body, original)
      } else {
        this.rearmIgnoredHook(source, body)
      }
    }
    this.replayTranscriptPolls.clear()
  }
}
