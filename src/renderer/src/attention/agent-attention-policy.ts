import type {
  AgentAttentionSubject,
  AgentAttentionSurface,
  AgentAttentionUnreadReason
} from './agent-attention-contract'

export type AgentAttentionRequest = {
  subject: AgentAttentionSubject
  reason: AgentAttentionUnreadReason
  /**
   * A settled turn owns the subject's attention, so its address is validated and unread is
   * decided. A bare surface signal (a bell) only has to prove the subject is still alive.
   */
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

/**
 * Decides what an attention event earns, asking the surface adapter for every fact.
 *
 * Admission and visibility are deliberately separate gates: a superseded surface is rejected
 * outright (no unread, no delivery), while a surface the user is watching is admitted and
 * delivered but earns no unread.
 */
export function resolveAgentAttention(
  request: AgentAttentionRequest,
  surface: AgentAttentionSurface
): AgentAttentionDecision {
  const { workspaceId } = request.subject
  // Why first: a muted workspace earns nothing, so unread, banner, sound and push stay in agreement.
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
