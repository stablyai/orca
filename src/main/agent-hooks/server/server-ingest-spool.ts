import {
  buildSpoolHookBody,
  type SpoolRecord
} from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import {
  isAgentHookSource,
  type AgentHookSource
} from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { PrefetchedStopReply } from '../../../shared/agent-hook-listener/transcript-lines'
import { withPrefetchedRolloutReads } from '../../../shared/agent-hook-listener/providers/codex/codex-rollout-prefetch-scope'
import type { PrefetchedHookReads } from './server-types'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'

export abstract class AgentHookServerIngestSpool extends AgentHookServerIngestNormalization {
  // Spool records are durable replay evidence, not a live observation.
  protected ingestSpoolRecord(record: SpoolRecord, answerBy?: number): Promise<void> | void {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const token = this.token
    const statusHookGeneration = this.statusHookGeneration
    const source = record.source
    const current = () =>
      this.statusHooksEnabled &&
      this.token === token &&
      this.statusHookGeneration === statusHookGeneration
    const apply = (reads: PrefetchedHookReads) => {
      try {
        if (!current()) {
          throw new Error('Status hook spool replay interrupted')
        }
        withPrefetchedRolloutReads(reads.rollout, () =>
          this.applySpoolHook(source, record, body, reads.stopReply)
        )
      } finally {
        reads.rollout?.batch.release()
      }
    }
    const body = this.normalizeHookBodyPaneKeyAlias(buildSpoolHookBody(record))
    const pending = this.checkHookOwner(source, body, answerBy)
    // Replayed hooks read live rollouts and transcripts too; keep those opens off the main thread (#43539).
    return Promise.resolve(pending)
      .then(() => this.prefetchHookReads(source, body, current, true))
      .then(apply)
  }

  private applySpoolHook(
    source: AgentHookSource,
    record: SpoolRecord,
    body: unknown,
    stopReply: PrefetchedStopReply | undefined
  ): void {
    const normalized = this.normalizeLocalHookPayload(source, body, true, stopReply)
    if (!normalized.event) {
      return
    }
    const exit = this.agentExitedAtByPaneKey.get(this.resolvePaneKeyAlias(normalized.event.paneKey))
    // Whole-second spool timestamps prove pre-exit ownership only with a full second of separation.
    if (exit && record.receivedAt + 1000 <= exit.at) {
      return
    }
    const replay = { ...normalized.event, isReplay: true as const }
    const statusDisposition = this.getAgentStatusDisposition(replay.paneKey, {
      source,
      hookEventName: replay.hookEventName,
      isReplay: true,
      hasExplicitPrompt: replay.hasExplicitPrompt,
      launchToken: replay.launchToken
    })
    if (statusDisposition === 'suppress') {
      return
    }
    const event = statusDisposition === 'restart' ? { ...replay, launchToken: undefined } : replay
    if (statusDisposition === 'restart') {
      this.observations.rebind(event.paneKey)
    }
    this.recordCurrentAuthorityObservation(event)
    const enriched = this.applyObservedLocalHook(event, normalized.onAccepted, record.receivedAt)
    // Replay defers children whose rollout path is unresolved; only the poll finds and reads them.
    if (enriched && source === 'codex') {
      this.requestReplayTranscriptPoll(body, enriched)
    }
    if (event.payload.state !== 'done') {
      this.withdrawReplayObservation(this.resolvePaneKeyAlias(event.paneKey))
    }
  }
}
