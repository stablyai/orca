import { codexReplayLeftTranscriptWork } from '../../../shared/agent-hook-listener/providers/codex/codex-state'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerStatusRetries } from './server-status-retries'

export abstract class AgentHookServerReplayTranscriptPolls extends AgentHookServerStatusRetries {
  /** Replay drains before the server binds, and a poll that runs then is dropped, so these wait for it to listen. */
  protected requestReplayTranscriptPoll(
    source: AgentHookSource,
    body: unknown,
    original?: EnrichedAgentHookEventPayload
  ): void {
    if (!original) {
      return
    }
    const { paneKey } = original
    if (source === 'antigravity') {
      // The spool may replace this row before the listener binds.
      this.replayTranscriptPolls.set(paneKey, { source, body: { paneKey } })
    } else if (source === 'codex' && codexReplayLeftTranscriptWork(this.state, paneKey)) {
      this.replayTranscriptPolls.set(paneKey, { source, body, original })
    }
    if (this.server?.listening) {
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
