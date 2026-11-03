import type { MobileWebBundleCompatManifest } from '../transport/web-bundle/mobile-web-bundle-compat'
import { cachedGenerationWall, gateVerdict } from './mobile-web-shell-gates'
import type {
  MobileWebShellSession,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'

// Reset all document facts together; the replacement must establish its own readiness, paint and Back claim.
export const CLEAR_PAGE_DOCUMENT_STATE = {
  pageReady: false,
  pagePainted: false,
  documentLoaded: false,
  pageBackClaimed: false
} as const

export type PageDocumentEvent = Extract<
  MobileWebShellSessionEvent,
  { type: 'page-ready' } | { type: 'page-painted' } | { type: 'page-back-claim' }
>

// Ignore page signals outside ready because their generation is no longer on screen.
export function pageDocumentStatePatch(
  session: Pick<MobileWebShellSession, 'state'>,
  event: PageDocumentEvent
): Partial<MobileWebShellSession> {
  if (session.state.kind !== 'ready') {
    return {}
  }
  if (event.type === 'page-back-claim') {
    return { pageBackClaimed: event.claimed }
  }
  if (event.type === 'page-ready') {
    // Ready clears the host claim too; the page must reassert anything it still holds.
    return { pageReady: true, pageBackClaimed: false }
  }
  return { pagePainted: true }
}

export function generationDocumentHealthy(session: MobileWebShellSession): boolean {
  return (
    session.state.kind === 'ready' &&
    session.documentLoaded &&
    session.pageReady &&
    session.pagePainted
  )
}

export function canConfirmGenerationDocument(
  session: MobileWebShellSession,
  manifest: MobileWebBundleCompatManifest
): boolean {
  const gates = session.gates
  if (!generationDocumentHealthy(session) || gates === null) {
    return false
  }
  const verdict = gateVerdict(gates)
  return (
    (verdict.kind === 'open' || verdict.kind === 'offline') &&
    cachedGenerationWall(verdict, gates, manifest) === null
  )
}

export function canConfirmSelectedGeneration(session: MobileWebShellSession): boolean {
  return (
    session.cached !== null &&
    session.state.kind === 'ready' &&
    session.cached.buildId === session.state.buildId &&
    canConfirmGenerationDocument(session, session.cached.compat)
  )
}
