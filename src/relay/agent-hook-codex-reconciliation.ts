import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import {
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  seedCodexStateFromSnapshot
} from '../shared/agent-hook-listener/providers/codex-state'
import { codexRosterEffectiveState, codexRosterToSnapshots } from '../shared/codex-subagent-roster'
import { reconcileCodexSubagentTranscript } from '../shared/codex-subagent-transcript'
import { seedCodexSubagentTranscriptFromSnapshot } from '../shared/codex-subagent-transcript-seeding'
import { createRelayCodexReconciler, type RelayHookStatusMeta } from './agent-hook-status-cache'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'

export function createRelayCodexReconciliationSchedulers(options: {
  state: HookListenerState
  isListening: () => boolean
  timers: Map<string, ReturnType<typeof setTimeout>>
  metadata: ReadonlyMap<string, RelayHookStatusMeta>
  forward: (envelope: AgentHookRelayEnvelope) => void
  persist: () => void
  gate: { nextRunAt: number }
}): { live: (paneKey: string) => void; restart: (paneKey: string) => void } {
  return {
    live: createRelayCodexReconciler({
      ...options,
      reconcile: (event) => reconcileRelayCodexEvent(options.state, event)
    }),
    restart: createRelayCodexReconciler({
      ...options,
      isReplay: true,
      reconcile: (event) =>
        reconcileRelayCodexEvent(options.state, event, { reconcileParentState: true })
    })
  }
}

export function reconcileRelayCodexEvent(
  state: HookListenerState,
  event: AgentHookEventPayload,
  options: { reconcileParentState?: boolean } = {}
): AgentHookEventPayload {
  const transcriptPath = event.providerSession?.transcriptPath
  if (!transcriptPath || event.payload.agentType !== 'codex') {
    return event
  }
  seedCodexStateFromSnapshot(state, event.paneKey, event.payload)
  const transcript = getOrCreateCodexSubagentTranscriptState(state, event.paneKey)
  if (event.payload.subagents?.length || event.codexSubagentsAuthoritative === true) {
    seedCodexSubagentTranscriptFromSnapshot(
      transcript,
      event.payload.subagents ?? [],
      transcriptPath,
      { authoritative: event.codexSubagentsAuthoritative === true }
    )
  }
  const roster = getOrCreateCodexSubagentRoster(state, event.paneKey)
  reconcileCodexSubagentTranscript(transcript, roster, transcriptPath)
  const subagents = codexRosterToSnapshots(roster)
  const reconciledParentState =
    transcript.parentTerminalObserved === true
      ? ('done' as const)
      : transcript.parentTerminalObserved === false
        ? event.payload.state === 'waiting'
          ? ('waiting' as const)
          : ('working' as const)
        : undefined
  const payload = {
    ...event.payload,
    ...(subagents ? { subagents } : { subagents: undefined }),
    ...(options.reconcileParentState && reconciledParentState
      ? { state: codexRosterEffectiveState(roster, reconciledParentState) }
      : {})
  }
  const codexAuthoritativeParentState =
    options.reconcileParentState &&
    transcript.parentReadable === true &&
    transcript.parentTerminalObserved !== undefined
      ? transcript.parentTerminalObserved
        ? ('done' as const)
        : payload.state === 'waiting' &&
            !payload.subagents?.some((subagent) => subagent.state === 'waiting')
          ? ('waiting' as const)
          : ('working' as const)
      : undefined
  const transcriptUnreadable =
    transcript.parentReadable === false ||
    [...transcript.subagents.values()].some((child) => child.unresolvedSince)
  const reconciledEvent = {
    ...event,
    payload,
    codexSubagentsAuthoritative:
      transcript.parentReadable === true && transcript.parent.coverageAuthoritative
        ? true
        : undefined,
    codexAuthoritativeParentState
  }
  return transcriptUnreadable
    ? reconciledEvent
    : event.reconcileDiagnostic?.reason === 'transcript-unreadable'
      ? { ...reconciledEvent, reconcileDiagnostic: null }
      : reconciledEvent
}
