import { CodexRolloutFollower } from '../../../shared/agent-hook-listener/providers/codex/codex-rollout-follower'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import {
  codexRolloutTailPath,
  codexRolloutWatchesName,
  shouldPollHookTranscript
} from '../../../shared/agent-hook-listener/transcript-poll-policy'
import type { AgentTranscriptPollScheduler } from '../../../shared/agent-hook-listener/transcripts/agent-transcript-poll-scheduler'

type TailPoll = { source: string; body: unknown }

/** One hook server's Codex rollout follow-up: reads the hooks ask for, and the watch-driven tail. */
export class ServerCodexRolloutTail<T extends TailPoll> {
  readonly follower: CodexRolloutFollower

  constructor(
    private readonly host: {
      state: HookListenerState
      env: () => string
      listening: () => boolean
      scheduler: () => AgentTranscriptPollScheduler<T>
      /** Store a restated row and re-arm the tail from what was stored. */
      publish: (update: AgentHookEventPayload, body: unknown) => void
    }
  ) {
    this.follower = new CodexRolloutFollower({
      log: (line) => console.debug(line),
      state: host.state,
      env: host.env,
      listening: host.listening,
      publish: (update, context) => host.publish(update, context.body)
    })
  }

  /** The tail watches the rollouts' directory and wakes for the root's and live children's files. */
  schedule(paneKey: string, poll: T): void {
    this.host
      .scheduler()
      .schedule(paneKey, poll, codexRolloutTailPath(this.host.state, paneKey), undefined, (name) =>
        codexRolloutWatchesName(this.host.state, paneKey, name)
      )
  }

  /** A tail tick publishes against whichever row is current, so a re-stamped row (a pane move) keeps it. */
  tick(paneKey: string, poll: T): void {
    const current = this.host.state.lastStatusByPaneKey.get(paneKey)
    if (
      !this.host.listening() ||
      current?.payload.agentType !== 'codex' ||
      !shouldPollHookTranscript(this.host.state, 'codex', current)
    ) {
      return
    }
    // The reads run off-thread and publish when they land; keep the tail armed meanwhile.
    this.follower.tail(paneKey)
    this.schedule(paneKey, poll)
  }

  /** A pane's authority moved: its reads in flight, held approvals and tail follow it. */
  move(fromPaneKey: string, toPaneKey: string, poll: T | undefined): void {
    this.follower.move(fromPaneKey, toPaneKey)
    // Re-arm the destination's tail now: a /review or failed-turn end may send no further hook.
    if (poll?.source === 'codex' && codexRolloutTailPath(this.host.state, toPaneKey)) {
      this.schedule(toPaneKey, poll)
    }
  }
}
