import type { Worktree } from '../../shared/worktree/types'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'

export type StructuredAgentSessionCreateWorktreeTarget = Readonly<{
  worktreeId: string
  workspacePath: string
  instanceId: string | null
  identityKey: string | null
  executionHostId: string | null
  creatorKind: 'host' | 'paired-device' | null
  creatorDeviceId: string | null
}>

export type StructuredAgentSessionCreateIntentInput = {
  envelope: { sessionId: string; clientOperationId: string }
  worktree: string
  agent: 'claude' | 'codex'
  callerKey?: string
  resumeFrom?: { providerSessionId: string }
  expectedWorktreeTarget?: StructuredAgentSessionCreateWorktreeTarget
}

export type ResolvedStructuredAgentSessionCreateTarget = {
  workspacePath: string
  location: AgentSessionExecutionLocation
}

export function structuredAgentSessionCreateWorktreeTarget(
  worktree: Pick<
    Worktree,
    'id' | 'path' | 'instanceId' | 'identity' | 'hostId' | 'creatorProvenance'
  >
): StructuredAgentSessionCreateWorktreeTarget {
  return Object.freeze({
    worktreeId: worktree.id,
    workspacePath: worktree.path,
    instanceId: worktree.instanceId ?? null,
    identityKey: worktree.identity?.key ?? null,
    executionHostId: worktree.identity?.executionHostId ?? worktree.hostId ?? null,
    creatorKind: worktree.creatorProvenance?.kind ?? null,
    creatorDeviceId:
      worktree.creatorProvenance?.kind === 'paired-device'
        ? worktree.creatorProvenance.deviceId
        : null
  })
}

export function structuredAgentSessionCreateWorktreeTargetsEqual(
  left: StructuredAgentSessionCreateWorktreeTarget,
  right: StructuredAgentSessionCreateWorktreeTarget
): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.workspacePath === right.workspacePath &&
    left.instanceId === right.instanceId &&
    left.identityKey === right.identityKey &&
    left.executionHostId === right.executionHostId &&
    left.creatorKind === right.creatorKind &&
    left.creatorDeviceId === right.creatorDeviceId
  )
}

export function structuredAgentSessionCreateLocationMatchesTarget(
  target: StructuredAgentSessionCreateWorktreeTarget,
  location: AgentSessionExecutionLocation
): boolean {
  return (
    target.worktreeId === location.workspaceId &&
    (target.executionHostId === null || target.executionHostId === location.executionHostId)
  )
}
