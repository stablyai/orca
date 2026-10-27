import type {
  AgentAttentionSubject,
  AgentAttentionSurface,
  AgentAttentionUnreadReason
} from './agent-attention-contract'

export type AgentAttentionRequest = {
  subject: AgentAttentionSubject
  reason: AgentAttentionUnreadReason
  /** Settled turns require address validation and decide unread; bare bell signals need only liveness proof. */
  settlesTurn: boolean
  /** Out-of-band proof the subject just produced work, used when no live session is visible. */
  hasFreshActivityEvidence: boolean
}

export type AgentAttentionUnreadWrite = {
  workspaceId: string
  subjectKey: string | null
  groupId: string | null
  reason: AgentAttentionUnreadReason
}

export type AgentAttentionDeliveryRequest = {
  workspaceId: string
  subjectKey: string | null
  /** Carried so the delivery owner can apply its own suppress-while-focused policy. */
  workspaceIsActive: boolean
}

export type AgentAttentionDecision =
  | {
      admitted: false
      cause: 'muted-workspace' | 'no-live-session' | 'unknown-surface' | 'superseded-surface'
    }
  | {
      admitted: true
      unread: AgentAttentionUnreadWrite | null
      delivery: AgentAttentionDeliveryRequest
    }

export type AgentAttentionSink = {
  /** The workspace-attention module's `markAgentAttentionUnread`. */
  unread: (write: AgentAttentionUnreadWrite) => void
  requestDelivery: (request: AgentAttentionDeliveryRequest) => void
}

/** Reject superseded surfaces entirely. Viewed surfaces may deliver attention but receive no unread marker; adapter facts keep admission separate from visibility. */
export function resolveAgentAttention(
  request: AgentAttentionRequest,
  surface: AgentAttentionSurface
): AgentAttentionDecision {
  const { workspaceId } = request.subject
  // Muted workspaces get no unread, banner, sound or push.
  if (surface.isWorkspaceMuted(workspaceId)) {
    return { admitted: false, cause: 'muted-workspace' }
  }
  const subjectKey = request.subject.surfaceKey ?? null
  const hasLiveSession = surface.hasLiveSession(request.subject)
  if (!hasLiveSession && !request.hasFreshActivityEvidence) {
    return { admitted: false, cause: 'no-live-session' }
  }

  let groupId: string | null = null
  if (request.settlesTurn && subjectKey !== null) {
    const admission = surface.admitSurface(
      { workspaceId, surfaceKey: subjectKey },
      { hasLiveSession, hasFreshActivityEvidence: request.hasFreshActivityEvidence }
    )
    if (!admission.admitted) {
      return { admitted: false, cause: admission.cause }
    }
    groupId = admission.groupId
  }

  const delivery: AgentAttentionDeliveryRequest = {
    workspaceId,
    subjectKey,
    workspaceIsActive: surface.isWorkspaceActive(workspaceId)
  }
  if (!request.settlesTurn) {
    return { admitted: true, unread: null, delivery }
  }

  const viewed =
    subjectKey === null
      ? surface.isWorkspaceViewed(workspaceId)
      : surface.isSurfaceViewed({ workspaceId, surfaceKey: subjectKey })
  return {
    admitted: true,
    unread: viewed ? null : { workspaceId, subjectKey, groupId, reason: request.reason },
    delivery
  }
}

/** Unread is written before delivery so a suppressed banner still leaves the marker behind. */
export function applyAgentAttention(
  decision: AgentAttentionDecision,
  sink: AgentAttentionSink
): void {
  if (!decision.admitted) {
    return
  }
  if (decision.unread !== null) {
    sink.unread(decision.unread)
  }
  sink.requestDelivery(decision.delivery)
}
