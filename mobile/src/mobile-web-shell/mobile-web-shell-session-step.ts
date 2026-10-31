import type {
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'

/**
 * The lowest `flow` number whose generation-check effects (`open-cache`, `read-manifest`,
 * `download`, `activate`) still belong to this session's current `startFlow`.
 *
 * `document-started` and `remounted` bump `session.flow` so an earlier document's load/ready
 * deadline timer cannot fire against its replacement, while keeping the same generation-check
 * flow floor so a `read-manifest` or background `download` launched alongside `open-generation`
 * is not dropped when the native WebView reports `document-started`.
 */
const flowFloors = new WeakMap<MobileWebShellSession, number>()

export function sessionFlowFloor(session: MobileWebShellSession): number {
  return flowFloors.get(session) ?? session.flow
}

export function acceptsSessionEventFlow(
  session: MobileWebShellSession,
  event: MobileWebShellSessionEvent
): boolean {
  if (!('flow' in event)) {
    return true
  }
  switch (event.type) {
    case 'remounted':
    case 'page-ready-deadline':
    case 'document-load-deadline':
      return event.flow === session.flow
    case 'cache-read':
    case 'manifest-read':
    case 'fetch-progress':
    case 'download-staged':
    case 'activated':
    case 'download-failed':
      return event.flow >= sessionFlowFloor(session) && event.flow <= session.flow
  }
}

/**
 * One transition, built in one place: the session the patch produces and the effects it owes.
 * Shared by the reducer and by the cached-generation opener beside it, so a step means the same
 * thing wherever it is taken.
 */
export function step(
  session: MobileWebShellSession,
  patch: Partial<MobileWebShellSession>,
  effects: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  const next = { ...session, ...patch }
  flowFloors.set(next, sessionFlowFloor(session))
  return { session: next, effects }
}

/** A transition that starts a new generation-check flow, retiring every effect in flight before it. */
export function stepNewFlow(
  session: MobileWebShellSession,
  patch: Partial<MobileWebShellSession> & { readonly flow: number },
  effects: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  const next = { ...session, ...patch }
  flowFloors.set(next, next.flow)
  return { session: next, effects }
}
