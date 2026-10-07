import { randomUUID } from 'node:crypto'
import { AGENT_STATUS_STALE_AFTER_MS } from '../shared/agent-status-types'
import { isRecord } from '../shared/agent-status-child-work-value-guards'
import { normalizeAgentProviderSession } from '../shared/agent-session-resume'
import { normalizeHostTurnRevision } from '../shared/agent-hook-interrupt-reconciliation'
import {
  opensNewTurn,
  restatesAnotherPrompt,
  resolveCancelVerdictLatch,
  type CancelVerdictLatchDecision
} from '../shared/agent-hook-cancel-verdict-latch'
import {
  markClaudeLeadTurnInterrupted,
  setClaudeMainAgentTurnState
} from '../shared/agent-hook-listener/providers/claude-roster-state'
import { claudeRowHasUnlistedLiveWork } from '../shared/agent-hook-listener/providers/claude-pane-hold-evidence'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import type { CachedPaneEnvelopeMeta } from './agent-hook-cached-pane-status'

export type RelayInterruptHost = {
  state: HookListenerState
  isListening: boolean
  getMetadata: (paneKey: string) => CachedPaneEnvelopeMeta | undefined
  getAgentLaunchToken: (paneKey: string) => string | undefined
  isPaneBlocked: (paneKey: string) => boolean
  apply: (
    event: AgentHookEventPayload,
    meta: CachedPaneEnvelopeMeta
  ) => AgentHookEventPayload | undefined
  armExpiry: (paneKey: string, meta: CachedPaneEnvelopeMeta) => void
}

export function inferRelayClaudeInterrupt(host: RelayInterruptHost, request: unknown): boolean {
  if (!isRecord(request) || request.intent !== 'ctrl-c' || typeof request.paneKey !== 'string') {
    return false
  }
  const row = host.state.lastStatusByPaneKey.get(request.paneKey)
  const meta = host.getMetadata(request.paneKey)
  const session = normalizeAgentProviderSession(request.providerSession)
  const expectedLaunchToken = host.getAgentLaunchToken(request.paneKey)
  if (
    !host.isListening ||
    !row ||
    !meta ||
    meta.source !== 'claude' ||
    host.isPaneBlocked(request.paneKey) ||
    Date.now() - (row.hostEvidenceObservedAt ?? 0) > AGENT_STATUS_STALE_AFTER_MS ||
    !normalizeHostTurnRevision(request.hostTurnRevision) ||
    row.hostTurnRevision !== request.hostTurnRevision ||
    row.launchToken !== request.launchToken ||
    (expectedLaunchToken !== undefined && row.launchToken !== expectedLaunchToken) ||
    !session ||
    row.providerSession?.id !== session.id ||
    row.providerSession.key !== session.key ||
    row.providerSessionOnly ||
    row.isReplay ||
    row.agentPresence?.ended ||
    row.payload.agentType !== 'claude' ||
    row.payload.state !== 'working' ||
    row.payload.mainAgent?.state !== 'working'
  ) {
    return false
  }
  return applyRelayClaudeInterrupt(host, row, meta)
}

export function applyRelayClaudeInterrupt(
  host: Pick<RelayInterruptHost, 'state' | 'apply' | 'armExpiry'>,
  row: AgentHookEventPayload,
  meta: CachedPaneEnvelopeMeta
): boolean {
  const cancelled = markClaudeLeadTurnInterrupted(host.state, row.paneKey)
  const { workingMode: _workingMode, interrupted: _interrupted, ...payload } = row.payload
  const accepted = host.apply(
    {
      ...row,
      hookEventName: undefined,
      hasExplicitPrompt: undefined,
      hostEvidenceObservedAt: Date.now(),
      claudeRunningNonAgentTask: claudeRowHasUnlistedLiveWork(host.state, row.paneKey),
      payload: {
        ...payload,
        ...cancelled,
        ...(cancelled.state === 'done' ? { interrupted: true } : {})
      }
    },
    meta
  )
  if (!accepted) {
    return false
  }
  host.armExpiry(row.paneKey, meta)
  return true
}

export function reconcileRelayClaudeCancel(
  state: HookListenerState,
  previous: AgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload,
  source: AgentHookSource
): CancelVerdictLatchDecision {
  if (
    source === 'claude' &&
    previous?.payload.agentType === 'claude' &&
    previous.launchToken === incoming.launchToken &&
    previous.providerSession?.id === incoming.providerSession?.id &&
    previous.providerSession?.key === incoming.providerSession?.key
  ) {
    const latch = resolveCancelVerdictLatch(
      {
        ...previous,
        receivedAt: previous.hostEvidenceObservedAt ?? Date.now()
      },
      incoming,
      Date.now()
    )
    if (latch.hold) {
      if (previous.payload.mainAgent?.state === 'done') {
        setClaudeMainAgentTurnState(state, incoming.paneKey, previous.payload.mainAgent)
      }
      return { hold: true }
    }
    return { hold: false, event: latch.event }
  }
  return { hold: false, event: incoming }
}

export function withRelayClaudeTurnRevision(
  previous: AgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload,
  source: AgentHookSource
): AgentHookEventPayload {
  return {
    ...incoming,
    ...(incoming.agentPresence?.ended ? { providerSessionOnly: true } : {}),
    ...(source === 'claude'
      ? {
          hostTurnRevision:
            previous?.hostTurnRevision &&
            previous.launchToken === incoming.launchToken &&
            previous.providerSession?.id === incoming.providerSession?.id &&
            previous.providerSession?.key === incoming.providerSession?.key &&
            !opensNewTurn(incoming) &&
            !restatesAnotherPrompt(previous, incoming)
              ? previous.hostTurnRevision
              : randomUUID()
        }
      : {}),
    hostEvidenceObservedAt: incoming.hostEvidenceObservedAt ?? Date.now()
  }
}
