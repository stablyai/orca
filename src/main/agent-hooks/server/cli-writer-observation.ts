import {
  resolveAgentStatusBinding,
  type AgentStatusRuntimeEnrichment
} from '../../ipc/agent-status-ipc-boundary'
import type { AgentStatusObservedPaneIdentities } from '../../runtime/agent-status-observed-pane-identity'
import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessVerdict
} from '../../../shared/agent-process-presence'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'

// Execution metadata follows the conversation binding and disappears at serialization.
export const OPEN_CODE_WRITER_TOPOLOGY = Symbol('openCodeWriterTopology')

export type CliWriterObservation = {
  current: () => boolean
  presence: () => Promise<AgentProcessVerdict | null>
  topology: 'pane-owned' | 'shared' | 'unverifiable'
}

export function retainOpenCodeWriterTopology(
  event: AgentHookEventPayload | null,
  source: AgentHookSource,
  body: unknown
): void {
  if (
    !event?.providerSession ||
    (source !== 'opencode' && source !== 'opencode2' && source !== 'mimo-code') ||
    !body ||
    typeof body !== 'object'
  ) {
    return
  }
  const major = 'opencodeMajor' in body ? body.opencodeMajor : undefined
  const topology =
    typeof major === 'number' && major >= 2
      ? 'pane-owned'
      : ('opencodeSharedServer' in body && body.opencodeSharedServer === 1) ||
          ('opencodeTui' in body && body.opencodeTui === 1)
        ? 'shared'
        : 'unverifiable'
  Object.defineProperty(event.providerSession, OPEN_CODE_WRITER_TOPOLOGY, { value: topology })
}

/** OpenCode-family servers can outlive their pane; only the binding they posted can prove otherwise. */
export function cliWriterTopology(row: AgentHookEventPayload): CliWriterObservation['topology'] {
  const binding = row.providerSession
  const topology =
    binding && OPEN_CODE_WRITER_TOPOLOGY in binding ? binding[OPEN_CODE_WRITER_TOPOLOGY] : undefined
  return topology === 'shared'
    ? 'shared'
    : row.source !== 'opencode' &&
        row.source !== 'opencode2' &&
        row.source !== 'mimo-code' &&
        row.payload.agentType !== 'opencode' &&
        row.payload.agentType !== 'opencode2'
      ? 'pane-owned'
      : topology === 'pane-owned'
        ? topology
        : 'unverifiable'
}

/** A tmux server outlives the pane it was started from, so nothing it publishes is pane-owned. */
export function tmuxCliWriterEvent<T extends AgentHookEventPayload>(row: T): T {
  if (!row.providerSession) {
    return row
  }
  const providerSession = { ...row.providerSession }
  Object.defineProperty(providerSession, OPEN_CODE_WRITER_TOPOLOGY, { value: 'shared' })
  return { ...row, providerSession }
}

export type CliWriterExecutionMatches = (
  row: AgentHookEventPayload,
  baseline?: AgentHookEventPayload
) => boolean

export function cliWriterExecutionMatcher(
  identities: Pick<AgentStatusObservedPaneIdentities, 'read'>,
  runtime: AgentStatusRuntimeEnrichment
): CliWriterExecutionMatches {
  return (row, baseline) => {
    const current = resolveAgentStatusBinding(row.paneKey, runtime)
    if (
      current.kind === 'unresolved' ||
      (row.terminalHandle && row.terminalHandle !== current.terminalHandle)
    ) {
      return false
    }
    if (!baseline) {
      return true
    }
    const observed = identities.read(baseline.paneKey)
    return (
      observed.kind === 'observed' &&
      observed.terminalHandle === current.terminalHandle &&
      observed.processIncarnation === current.processIncarnation
    )
  }
}

/** Validate before enriched listeners can recapture a replacement execution as this row's owner. */
export function deriveCliWriterTopology<T extends AgentHookEventPayload>(
  row: T,
  baseline: AgentHookEventPayload | undefined,
  matches: CliWriterExecutionMatches | null,
  newRun = false,
  sender: AgentProcessIdentity | undefined = row.agentPresence?.process
): T {
  const binding = row.providerSession
  if (!binding || !(OPEN_CODE_WRITER_TOPOLOGY in binding)) {
    return row
  }
  const inherited = baseline?.providerSession === binding
  const owner = baseline?.agentPresence?.process
  if (
    !newRun &&
    row.connectionId === null &&
    (!sender || !owner || isSameAgentProcess(sender, owner)) &&
    (!inherited ||
      (baseline.connectionId === null &&
        baseline.worktreeId === row.worktreeId &&
        baseline.payload.agentType === row.payload.agentType &&
        baseline.providerSession?.key === binding.key &&
        baseline.providerSession.id === binding.id)) &&
    matches?.(row, inherited ? baseline : undefined)
  ) {
    return row
  }
  return { ...row, providerSession: { ...binding } }
}
