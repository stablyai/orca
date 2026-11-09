import { retainOpenCodeWriterTopology } from './cli-writer-observation'
import { AgentHookAttributionDiagnostics } from '../../../shared/agent-hook-listener/state/agent-hook-attribution-diagnostics'
import {
  buildSpoolHookBody,
  type SpoolRecord
} from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import {
  checkHookOwnerPresence,
  restateHookRoot
} from '../../../shared/agent-hook-listener/presence/agent-hook-owner-presence'
import type { HookRootEvidenceReader } from '../../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import {
  isAgentHookSource,
  type AgentHookSource
} from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import {
  captureClaudeTaskAdmissionState,
  restoreClaudeTaskAdmissionState
} from './server-claude-task-notification-admission'
import { hasClaudeIdlePromptTaskObservation } from '../../../shared/agent-hook-listener/providers/claude-task-notification-reconciliation'
import { readClaudeTaskNotificationEvidence } from '../../../shared/agent-hook-listener/providers/claude-task-notification-evidence-reader'
import {
  bindOpenCodeTuiSession,
  isOpenCodeSharedServerPost
} from '../../../shared/agent-hook-listener/opencode-session-registry'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'
import { AgentHookServerTmuxStatus } from './server-tmux-status'
import { getClaudeObservedConfigDirs } from '../../claude-accounts/claude-profile-installed-router'

export abstract class AgentHookServerIngestNormalization extends AgentHookServerTmuxStatus {
  protected readonly attributionDiagnostics = new AgentHookAttributionDiagnostics()
  /** Unset in tests and embedders without a process table: every acquisition reads as unknown. */
  protected readHookRootEvidence: HookRootEvidenceReader | undefined

  setHookRootEvidenceReader(reader: HookRootEvidenceReader): void {
    this.readHookRootEvidence = reader
  }

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

  protected async normalizeLocalHookPayload(
    source: AgentHookSource,
    body: unknown,
    isReplay = false
  ): Promise<NormalizedLocalHook> {
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
      return { event: normalizeHookPayload(this.state, source, body, this.env) }
    }
    const rawHookPayload = readHookPayload(body)
    const eventName = rawHookPayload['hook_event_name']
    const transcriptEvidence = await readClaudeTaskNotificationEvidence(
      this.state,
      paneKey,
      eventName,
      rawHookPayload
    )
    const tracksTranscriptObservation =
      eventName === 'Stop' ||
      eventName === 'StopFailure' ||
      eventName === 'SubagentStart' ||
      eventName === 'SubagentStop'
    const isIdlePrompt =
      eventName === 'Notification' && rawHookPayload['notification_type'] === 'idle_prompt'
    const hasIdlePromptTaskObservation =
      isIdlePrompt && hasClaudeIdlePromptTaskObservation(this.state, paneKey, rawHookPayload)
    const admissionOptions = {
      transcript: tracksTranscriptObservation || hasIdlePromptTaskObservation,
      idlePrompt: hasIdlePromptTaskObservation
    }
    const previousAdmissionState = captureClaudeTaskAdmissionState(
      this.state,
      paneKey,
      admissionOptions
    )
    const event = normalizeHookPayload(this.state, source, body, this.env, {
      claudeTaskTranscriptEvidence: transcriptEvidence
    })
    const transcriptPath = event?.providerSession?.transcriptPath
    if (transcriptPath) {
      // A wrapper's CLAUDE_CONFIG_DIR is only visible here; History scans it too (#23505).
      getClaudeObservedConfigDirs()?.observeTranscriptPath(transcriptPath)
    }
    const nextAdmissionState = captureClaudeTaskAdmissionState(
      this.state,
      paneKey,
      admissionOptions
    )
    restoreClaudeTaskAdmissionState(this.state, paneKey, previousAdmissionState)
    if (!event || event.paneKey !== paneKey) {
      return { event }
    }
    // Nested CLIs inherit pane keys; rejected status must not change the owner's background-work gate.
    return {
      event,
      onAccepted: () => restoreClaudeTaskAdmissionState(this.state, paneKey, nextAdmissionState)
    }
  }

  // Spool records are durable replay evidence, not a live observation.
  protected ingestSpoolRecord(record: SpoolRecord, answerBy?: number): Promise<void> | void {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const token = this.token
    const statusHookGeneration = this.statusHookGeneration
    const apply = async () => {
      if (
        !this.statusHooksEnabled ||
        this.token !== token ||
        this.statusHookGeneration !== statusHookGeneration
      ) {
        throw new Error('Status hook spool replay interrupted')
      }
      await this.applySpoolHook(record, body)
    }
    const body = this.normalizeHookBodyPaneKeyAlias(buildSpoolHookBody(record))
    const pending = this.checkHookOwner(record.source, body, answerBy)
    return pending ? pending.then(apply) : apply()
  }

  private async applySpoolHook(record: SpoolRecord, body: unknown): Promise<void> {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const normalized = await this.normalizeLocalHookPayload(record.source, body, true)
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
      source: record.source,
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
    this.applyObservedLocalHook(event, normalized.onAccepted, record.receivedAt)
    if (event.payload.state !== 'done') {
      this.withdrawReplayObservation(this.resolvePaneKeyAlias(event.paneKey))
    }
  }
}

function readHookPayload(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || !isRecord(body.payload)) {
    return {}
  }
  return body.payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
