import {
  retainOpenCodeWriterTopology,
  retainTmuxHookWriterTopology
} from './cli-writer-observation'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { AgentHookAttributionDiagnostics } from '../../../shared/agent-hook-listener/state/agent-hook-attribution-diagnostics'
import {
  checkHookOwnerPresence,
  restateHookRoot
} from '../../../shared/agent-hook-listener/presence/agent-hook-owner-presence'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import {
  type PrefetchedStopReply,
  withPrefetchedStopReply
} from '../../../shared/agent-hook-listener/transcript-lines'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import {
  bindOpenCodeTuiSession,
  isOpenCodeSharedServerPost
} from '../../../shared/agent-hook-listener/opencode-session-registry'
import type {
  EnrichedAgentHookEventPayload,
  NormalizedLocalHook,
  PrefetchedHookReads
} from './server-types'
import { AgentHookServerTmuxStatus } from './server-tmux-status'
import { getClaudeObservedConfigDirs } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'

import { prefetchCodexHookRolloutReadsWithin } from '../../../shared/agent-hook-listener/providers/codex/codex-hook-rollout-prefetch'
import { HookPrefetchQueue } from '../../../shared/agent-hook-listener/hook-prefetch-queue'
import { prefetchStopReply } from './stop-reply-prefetch'

export abstract class AgentHookServerIngestNormalization extends AgentHookServerTmuxStatus {
  protected readonly hookPrefetchQueue = new HookPrefetchQueue()

  protected readonly attributionDiagnostics = new AgentHookAttributionDiagnostics()
  /** Panes whose owner an undecided hook challenged: until that hook is admitted or refused, the
   *  owner's exit neither answers for the pane nor is forgotten. */
  protected readonly undecidedOwnerChallenges = new Map<string, number>()

  /** HTTP and spool hooks share one ownership preflight before provider folds; a drain passes
   *  the one answer deadline all its records share. */
  protected checkHookOwner(
    source: AgentHookSource,
    body: unknown,
    answerBy?: number
  ): Promise<unknown> | undefined {
    const challenges = this.undecidedOwnerChallenges
    let challenged: string | undefined
    const read = this.readHookRootEvidence
    const pending = checkHookOwnerPresence(
      this.state,
      source,
      body,
      this.env,
      (paneKey) => {
        challenged = this.resolvePaneKeyAlias(paneKey)
        challenges.set(challenged, (challenges.get(challenged) ?? 0) + 1)
        return this.checkAgentPresence(paneKey)
      },
      read && {
        read,
        answerBy,
        // A late answer re-applies the pane's current row with the authority it settles.
        reconcile: (completion) => {
          const event = this.statusHooksEnabled
            ? restateHookRoot(this.state, completion)
            : undefined
          if (event) {
            this.applyNormalizedStatus(event)
          }
        }
      }
    )
    // The caller admits or refuses the hook as soon as this settles, with no await in between.
    return pending?.finally(() => {
      if (!challenged) {
        return
      }
      const remaining = (challenges.get(challenged) ?? 1) - 1
      if (remaining > 0) {
        challenges.set(challenged, remaining)
      } else {
        challenges.delete(challenged)
      }
    })
  }

  protected override applyNormalizedStatus(
    ...args: Parameters<AgentHookServerTmuxStatus['applyNormalizedStatus']>
  ): EnrichedAgentHookEventPayload | undefined {
    const applied = super.applyNormalizedStatus(...args)
    const [incoming, , origin = 'hook'] = args
    // Claude can still block the prompt after this hook, and its idle may already have landed.
    if (
      applied?.payload.agentType === 'claude' &&
      origin === 'hook' &&
      incoming.hookEventName === 'UserPromptSubmit' &&
      this.programStatusFacets.claimPrompt(applied.paneKey)
    ) {
      this.settleClaudePromptBlocked(applied)
    }
    return applied
  }

  protected setClaudeBackgroundEvidence(
    paneKey: string,
    hasRunningTask: boolean,
    hasActiveCron: boolean
  ): void {
    if (hasRunningTask) {
      this.state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
    } else {
      this.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
    }
    if (hasActiveCron) {
      this.state.claudeActiveSessionCronPaneKeys.add(paneKey)
    } else {
      this.state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    }
  }

  /** Reads off the event loop what this hook's normalize would: Codex rollouts, or a textless Stop's reply. */
  protected async prefetchHookReads(
    source: AgentHookSource,
    body: unknown,
    keepReading: () => boolean,
    isReplay = false
  ): Promise<PrefetchedHookReads> {
    if (source === 'codex') {
      return { rollout: await prefetchCodexHookRolloutReadsWithin(this.state, body) }
    }
    // A replayed transcript has long since flushed; one read is enough.
    return {
      stopReply: await prefetchStopReply(source, body, keepReading, isReplay ? 1 : undefined)
    }
  }

  /** Never scans a transcript on the event loop: a textless Stop takes the reply prefetched for it. */
  protected normalizeLocalHookPayload(
    source: AgentHookSource,
    body: unknown,
    isReplay = false,
    stopReply: PrefetchedStopReply = {}
  ): NormalizedLocalHook {
    const value = withPrefetchedStopReply(stopReply, () =>
      this.normalizeLocalHookPayloadNow(source, body, isReplay)
    )
    retainTmuxHookWriterTopology(value.event, body)
    return value
  }

  private normalizeLocalHookPayloadNow(
    source: AgentHookSource,
    body: unknown,
    isReplay: boolean
  ): NormalizedLocalHook {
    if (source !== 'claude' || typeof body !== 'object' || body === null) {
      const event = normalizeHookPayload(this.state, source, body, this.env, {
        admitOpenCodeTui: (identity) => {
          const disposition = this.getAgentStatusDisposition(identity.paneKey, {
            ...identity,
            source,
            isReplay
          })
          if (disposition === 'restart') {
            this.observations.rebind(identity.paneKey)
          }
          return disposition !== 'suppress'
        }
      })
      retainOpenCodeWriterTopology(event, source, body)
      if (
        event &&
        event.hookEventName === 'SessionStart' &&
        isOpenCodeSharedServerPost(source, body)
      ) {
        this.kickOpenCodeBinder()
      }
      return {
        event,
        onAccepted: () =>
          bindOpenCodeTuiSession(this.state, source, body, event?.providerSession?.id)
      }
    }
    const rawPaneKey = (body as Record<string, unknown>).paneKey
    const paneKey = typeof rawPaneKey === 'string' ? rawPaneKey.trim() : ''
    if (!paneKey) {
      return { event: normalizeHookPayload(this.state, source, body, this.env, { isReplay }) }
    }
    const previousRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const previousActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    const event = normalizeHookPayload(this.state, source, body, this.env, { isReplay })
    const transcriptPath = event?.providerSession?.transcriptPath
    if (transcriptPath) {
      // A wrapper's CLAUDE_CONFIG_DIR is only visible here; History scans it too (#23505).
      getClaudeObservedConfigDirs()?.observeTranscriptPath(transcriptPath)
    }
    const nextRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const nextActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    this.setClaudeBackgroundEvidence(paneKey, previousRunningTask, previousActiveCron)
    if (!event || event.paneKey !== paneKey) {
      return { event }
    }
    // Nested CLIs inherit pane keys; rejected status must not change the owner's background-work gate.
    return {
      event,
      onAccepted: () => this.setClaudeBackgroundEvidence(paneKey, nextRunningTask, nextActiveCron)
    }
  }

  /** Normalizes and applies one local hook; returns the row that owns its tool call, if any. */
  protected ingestLocalHook(
    source: AgentHookSource,
    aliasedBody: unknown,
    stopReply?: PrefetchedStopReply
  ): NormalizedLocalHook['event'] {
    const normalized = this.normalizeLocalHookPayload(source, aliasedBody, false, stopReply)
    if (source === 'muse' && !normalized.event) {
      this.rearmIgnoredMuseHook(aliasedBody)
    }
    const statusDisposition = normalized.event
      ? this.getAgentStatusDisposition(normalized.event.paneKey, {
          source,
          hookEventName: normalized.event.hookEventName,
          isReplay: normalized.event.isReplay,
          hasExplicitPrompt: normalized.event.hasExplicitPrompt,
          opensTurn: normalized.event.opensTurn,
          launchToken: normalized.event.launchToken
        })
      : 'suppress'
    let toolCallOwner: NormalizedLocalHook['event'] = null
    if (normalized.event && statusDisposition !== 'suppress') {
      const restartedAuthority =
        statusDisposition === 'restart' && source === 'omp'
          ? this.restoreRetiredStatusRestart(normalized.event.paneKey)
          : undefined
      const event =
        statusDisposition === 'restart'
          ? {
              ...normalized.event,
              launchToken: undefined,
              ...(restartedAuthority
                ? {
                    ...restartedAuthority,
                    tabId: parsePaneKey(restartedAuthority.paneKey)?.tabId
                  }
                : {})
            }
          : normalized.event
      if (statusDisposition === 'restart') {
        // A new session must not inherit the retired one's observation order.
        this.observations.rebind(event.paneKey)
      }
      this.recordCurrentAuthorityObservation(event)
      toolCallOwner = event
      const rowBefore = this.state.lastStatusByPaneKey.get(event.paneKey)
      const enriched = this.applyObservedLocalHook(event, normalized.onAccepted)
      // A refused hook must not retry onto the row it lost to; a prefetched reply already retried.
      if (enriched && enriched !== rowBefore && !stopReply) {
        this.scheduleAssistantMessageRetry(source, aliasedBody, enriched)
      }
      if (enriched) {
        this.checkAgentPresenceAfterHook(event, enriched)
        this.scheduleTranscriptPoll(source, aliasedBody, enriched)
      }
    }
    return toolCallOwner
  }
}
