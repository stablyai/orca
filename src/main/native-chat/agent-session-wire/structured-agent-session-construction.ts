import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'

export type RecoveryConstructionPermit = {
  handoffId: string
  targetAttemptId: string
  sourceLinkId: string
  fence: number
}
export type RecoveryConstructionIntent = { kind: 'recovery'; permit: RecoveryConstructionPermit }
export type ConstructionStep<T> =
  | { kind: 'ready'; value: T }
  | {
      kind: 'history-unavailable'
      sourceLink: AgentSessionProviderHandleLink
      trigger: 'codex-no-rollout' | 'pi-session-missing' | 'acp-load-rejected'
      createFresh: (permit: RecoveryConstructionPermit, signal: AbortSignal) => Promise<T>
    }

export function readyConstruction<T>(value: T): ConstructionStep<T> {
  return { kind: 'ready', value }
}

export function assertRecoveryConstructionPermit(
  permit: RecoveryConstructionPermit,
  source: AgentSessionProviderHandleLink,
  fence: number
): void {
  if (
    permit.fence !== fence ||
    permit.sourceLinkId !== source.linkId ||
    !permit.handoffId ||
    !permit.targetAttemptId
  ) {
    throw new Error('Recovery construction changed ownership')
  }
}

function isConstructionStep<T extends object>(
  value: T | ConstructionStep<T>
): value is ConstructionStep<T> {
  return 'kind' in value && (value.kind === 'ready' || value.kind === 'history-unavailable')
}
export function normalizeConstruction<T extends object>(
  value: T | ConstructionStep<T>
): ConstructionStep<T> {
  return isConstructionStep(value) ? value : readyConstruction(value)
}
