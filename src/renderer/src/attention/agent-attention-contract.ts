/**
 * Provider-neutral agent attention boundary.
 *
 * Nothing in this folder may import a PTY, terminal leaf or terminal layout module: a
 * surface adapter answers every question about where a subject lives and who can see it,
 * so a non-terminal agent surface can supply its own adapter without touching the policy.
 */

/** Why an unread marker exists. `legacy` is a marker written before reasons were recorded. */
export type AgentAttentionUnreadReason =
  | 'agent-completion'
  | 'terminal-bell'
  | 'manual-mark-unread'
  | 'legacy'

/** Stored marker shape: a classified reason, or the pre-reason boolean still on live state. */
export type StoredAgentAttentionUnread = AgentAttentionUnreadReason | true

/** What a reader may find, including a marker some other writer cleared to `false`. */
export type ReadableAgentAttentionUnread = AgentAttentionUnreadReason | boolean | undefined

/** Reads a marker without guessing its origin: an unclassified boolean reports as `legacy`. */
export function readAgentAttentionUnreadReason(
  marker: ReadableAgentAttentionUnread
): AgentAttentionUnreadReason | null {
  if (marker === undefined || marker === false) {
    return null
  }
  return marker === true ? 'legacy' : marker
}

/** A workspace-scoped attention subject; `surfaceKey` addresses one surface inside it. */
export type AgentAttentionSubject = {
  workspaceId: string
  surfaceKey?: string | undefined
}

/** A subject that names a concrete surface, so the adapter can resolve its container. */
export type AgentAttentionSurfaceSubject = {
  workspaceId: string
  surfaceKey: string
}

/** What the boundary knows about the subject still being alive when it admits an event. */
export type AgentAttentionLiveness = {
  hasLiveSession: boolean
  hasFreshActivityEvidence: boolean
}

/** Whether a surface key still addresses the surface that produced the event. */
export type AgentAttentionSurfaceAdmission =
  | { admitted: true; groupId: string }
  | { admitted: false; cause: 'unknown-surface' | 'superseded-surface' }

/** Attention still held elsewhere in a workspace, as the owning surface sees it. */
export type AgentAttentionRemainder = {
  /** False when the workspace owns no surfaces at all, so nothing can hold its unread. */
  hasSurfaces: boolean
  unreadSubjectKeys: readonly string[]
  unreadGroupIds: readonly string[]
}

/**
 * The surface-shaped half of the boundary. One implementation per agent surface kind;
 * the terminal implementation is the only holder of the PTY/leaf/layout predicates.
 */
export type AgentAttentionSurface = {
  /** Is there still a running session behind this subject? */
  hasLiveSession: (subject: AgentAttentionSubject) => boolean
  /** Resolve the surface to its current container, rejecting a stale or reused address. */
  admitSurface: (
    subject: AgentAttentionSurfaceSubject,
    liveness: AgentAttentionLiveness
  ) => AgentAttentionSurfaceAdmission
  /** Is this exact surface the one the user is looking at right now? */
  isSurfaceViewed: (subject: AgentAttentionSurfaceSubject) => boolean
  /** Fallback for events with no surface key: is the workspace itself on screen? */
  isWorkspaceViewed: (workspaceId: string) => boolean
  /** In-app selection only — true even when the window is in the background. */
  isWorkspaceActive: (workspaceId: string) => boolean
  /** The subject on screen inside a container, if the container shows one. */
  resolveViewedSubjectKey: (groupId: string) => string | null
  /** Attention held by the workspace's other surfaces, for sibling protection. */
  collectWorkspaceAttentionRemainder: (workspaceId: string) => AgentAttentionRemainder
}
