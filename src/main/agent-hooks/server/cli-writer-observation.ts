import {
  resolveAgentStatusBinding,
  type AgentStatusRuntimeEnrichment
} from '../../ipc/agent-hooks/agent-status-ipc-boundary'
import type { AgentStatusObservedPaneIdentities } from '../../runtime/terminal/identity/agent-status-observed-pane-identity'
import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessVerdict
} from '../../../shared/agent-status/process/agent-process-presence'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { sameAgentStatusTerminalOwner } from '../../../shared/agent-status/identity/agent-status-terminal-owner'
import { cliWriterTopology, type CliWriterTopology } from './cli-writer-topology'
import {
  readTmuxHookPane,
  readTmuxHookPaneHint
} from '../../../shared/agent-hook-listener/presence/tmux-client-attachment'

export type CliWriterObservation = {
  current: () => boolean
  presence: () => Promise<AgentProcessVerdict | null>
  topology: CliWriterTopology
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
  event.executionHost = topology
}

/** A tmux server outlives the pane it was started from, so nothing it publishes is pane-owned. */
export function tmuxCliWriterEvent<T extends AgentHookEventPayload>(row: T): T {
  return row.providerSession ? { ...row, executionHost: 'shared' } : row
}

/** A hook that ran inside a tmux pane reaches this pane through a client; its server outlives the
 *  pane even after the client detaches, when the pane's foreground no longer shows tmux. A pane
 *  that only inherited Orca's own tmux environment hosts nothing. */
export function retainTmuxHookWriterTopology(
  event: AgentHookEventPayload | null,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!event?.providerSession || !body || typeof body !== 'object') {
    return
  }
  const tmux =
    readTmuxHookPane('tmux' in body ? body.tmux : undefined) ??
    readTmuxHookPaneHint('tmuxPane' in body ? body.tmuxPane : undefined)
  const inherited = readTmuxHookPaneHint(
    env.TMUX_PANE && env.TMUX ? `${env.TMUX_PANE} ${env.TMUX.split(',')[0]}` : undefined
  )
  // A decided binding keeps its topology.
  if (tmux && !(inherited?.pane === tmux.pane && inherited.socket === tmux.socket)) {
    event.executionHost ??= 'shared'
  }
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
  // The host follows the conversation's binding: a row that carries the baseline's own binding
  // carries its host.
  if (
    binding &&
    row.executionHost === undefined &&
    baseline?.providerSession === binding &&
    baseline.executionHost !== undefined
  ) {
    row = { ...row, executionHost: baseline.executionHost }
  }
  if (!binding || row.executionHost === undefined) {
    if (
      binding &&
      baseline &&
      cliWriterTopology(baseline) === 'shared' &&
      !newRun &&
      row.payload.agentType === baseline.payload.agentType &&
      sameAgentStatusTerminalOwner(baseline, row) &&
      agentProviderSessionsEqual(row.payload.agentType, baseline.providerSession, binding) &&
      (!sender ||
        !baseline.agentPresence?.process ||
        isSameAgentProcess(sender, baseline.agentPresence.process)) &&
      matches?.(row, baseline)
    ) {
      return tmuxCliWriterEvent(row)
    }
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
  // A tmux host outlives an unverified writer too; only an unverified pane-owned claim is dropped.
  if (row.executionHost === 'shared') {
    return row
  }
  const unverified = { ...row, providerSession: { ...binding } }
  delete unverified.executionHost
  return unverified
}

export { cliWriterTopology }
