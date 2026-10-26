/** Keep this boundary provider-neutral: no PTY/leaf/layout imports. Surface adapters own location and visibility facts so other agent surfaces can reuse policy. */

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

/** One adapter per surface kind; only the terminal adapter holds PTY/leaf/layout predicates. */
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
  /** Has the user silenced this workspace's attention (a sidebar Filters switch hides it)? */
  isWorkspaceMuted: (workspaceId: string) => boolean
  /** The subject on screen inside a container, if the container shows one. */
  resolveViewedSubjectKey: (groupId: string) => string | null
}
