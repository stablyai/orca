import type {
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'

// Separate generation-check flow floor from document-started/remounted timer bumps so background updates survive cached WebView loads.
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

export function step(
  session: MobileWebShellSession,
  patch: Partial<MobileWebShellSession>,
  effects: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  const next = { ...session, ...patch }
  flowFloors.set(next, sessionFlowFloor(session))
  return { session: next, effects }
}

// Retire in-flight generation checks and downloads when starting a new flow or entering a terminal failure.
export function stepNewFlow(
  session: MobileWebShellSession,
  patch: Partial<MobileWebShellSession> & { readonly flow: number },
  effects: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  const next = { ...session, ...patch }
  flowFloors.set(next, next.flow)
  return { session: next, effects }
}
