import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { StructuredAgentSessionCloseCause } from '../../native-chat/agent-session-wire/structured-agent-session-host-lifetime'
import {
  observeStructuredSession,
  structuredSessionCloseSettled
} from '../structured-worker-authority'

export type StructuredAgentSessionCloseOutcome = {
  stopped: boolean
  closeAttempted: boolean
  reason?: string
}

export type StructuredSessionSurfaceRuntime = Pick<
  OrcaRuntimeService,
  | 'currentLocalStructuredSessionPresentation'
  | 'captureStructuredAgentSessionPresentation'
  | 'retireStructuredAgentSessionTabFromSnapshot'
  | 'removeCapturedStructuredSessionSavedTabs'
>

export type StructuredSessionSurface = {
  tableId: string | null
  presentation?: ReturnType<
    StructuredSessionSurfaceRuntime['captureStructuredAgentSessionPresentation']
  >
}

export type StructuredAgentSessionCloseOptions = {
  runtime?: StructuredSessionSurfaceRuntime
  surface?: StructuredSessionSurface | null
  afterClose?: () => void
  // Last word in the session lane before Stop.
  admitClose?: () => boolean
}

export async function closeStructuredAgentSessionChild(
  sessionId: string,
  options: StructuredAgentSessionCloseOptions = {}
): Promise<StructuredAgentSessionCloseOutcome> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return {
      stopped: false,
      closeAttempted: false,
      reason: 'The structured agent-session host is not installed; no session was closed.'
    }
  }
  const surface =
    options.surface === undefined
      ? captureStructuredSessionSurface(host, sessionId, options.runtime)
      : options.surface
  const admitClose = options.admitClose
  let admitted = admitClose === undefined
  let closeFailure: string | undefined
  try {
    await host.close(
      sessionId,
      'evict',
      admitClose
        ? () => {
            admitted = admitClose()
            return admitted
          }
        : undefined
    )
  } catch (error) {
    closeFailure = error instanceof Error ? error.message : String(error)
  } finally {
    // A refused close leaves the live worker's ownership and retry edges intact.
    if (admitted) {
      options.afterClose?.()
    }
  }
  if (!admitted || !structuredSessionCloseSettled(sessionId)) {
    return {
      stopped: false,
      closeAttempted: true,
      reason:
        closeFailure ??
        observeStructuredSession(sessionId).reason ??
        'The structured session is still attached after close.'
    }
  }
  await retireCapturedStructuredSessionSurface(host, sessionId, surface, options.runtime)
  return { stopped: true, closeAttempted: true }
}

/** Capture actual presentation independently: a failed SHOW can leave Retry with no table row. */
export function captureStructuredSessionSurface(
  host: StructuredAgentSessionHost,
  sessionId: string,
  runtime?: StructuredSessionSurfaceRuntime
): StructuredSessionSurface | null {
  try {
    return {
      tableId: host.getSessionTabId(sessionId),
      ...(runtime
        ? { presentation: runtime.captureStructuredAgentSessionPresentation(sessionId) }
        : {})
    }
  } catch (error) {
    host.deps.logger.warn('reading the closing chat surface failed', {
      scope: 'tab-close-capture',
      sessionId,
      error
    })
    return null
  }
}

export function structuredSessionSurfaceIsCurrent(
  host: StructuredAgentSessionHost,
  sessionId: string,
  surface: StructuredSessionSurface | null,
  runtime?: StructuredSessionSurfaceRuntime,
  hidden = false
): boolean {
  if (!surface) {
    return false
  }
  try {
    if (host.getSessionTabId(sessionId) !== (hidden ? null : surface.tableId)) {
      return false
    }
    if (!surface.presentation) {
      return !runtime
    }
    if (!runtime) {
      return false
    }
    const raw = runtime.currentLocalStructuredSessionPresentation(sessionId)
    const captured = surface.presentation.raw
    return (
      raw === null ||
      (captured !== null && raw.worktreeId === captured.worktreeId && raw.tabId === captured.tabId)
    )
  } catch {
    return false
  }
}

/** Bookkeeping cannot invalidate native proof or reach a surface created after admission. */
export async function retireCapturedStructuredSessionSurface(
  host: StructuredAgentSessionHost,
  sessionId: string,
  surface: StructuredSessionSurface | null,
  runtime?: StructuredSessionSurfaceRuntime
): Promise<{ committed: boolean; error?: unknown }> {
  const current = (hidden = false) =>
    structuredSessionSurfaceIsCurrent(host, sessionId, surface, runtime, hidden)
  if (!current()) {
    return { committed: false }
  }
  let committed = false
  let failure: unknown
  const obsolete = new Error('Chat tab was replaced')
  try {
    await host.setSessionTabVisibility(sessionId, false, undefined, {
      deferHiddenNotice: true,
      check: () => {
        if (!current()) {
          throw obsolete
        }
      }
    })
    committed = true
  } catch (error) {
    if (error === obsolete || !current()) {
      return { committed: false }
    }
    failure = error
    host.deps.logger.warn('recording a closed chat tab failed', {
      scope: 'tab-close-hide',
      sessionId,
      error
    })
  }
  if (!current(committed)) {
    return { committed: false }
  }
  const presentation = surface?.presentation
  try {
    if (presentation?.raw) {
      runtime?.retireStructuredAgentSessionTabFromSnapshot(
        sessionId,
        presentation.raw.tabId,
        presentation.raw.worktreeId
      )
    }
    if (committed && current(true)) {
      if (presentation) {
        runtime?.removeCapturedStructuredSessionSavedTabs(sessionId, presentation.saved)
      }
      host.notifySessionTabHidden?.(sessionId)
    }
  } catch (error) {
    host.deps.logger.warn('cleaning up a closed chat presentation failed', {
      scope: 'tab-close-presentation-cleanup',
      sessionId,
      error
    })
  }
  return { committed, ...(failure === undefined ? {} : { error: failure }) }
}

/** Phone closes and cancelled creates admit the captured surface before stopping its provider. */
export async function closeCapturedStructuredSession(
  host: StructuredAgentSessionHost,
  sessionId: string,
  cause: StructuredAgentSessionCloseCause,
  surface: StructuredSessionSurface | null,
  runtime: StructuredSessionSurfaceRuntime
): Promise<boolean> {
  if (surface && !structuredSessionSurfaceIsCurrent(host, sessionId, surface, runtime)) {
    return false
  }
  const result = await retireCapturedStructuredSessionSurface(host, sessionId, surface, runtime)
  if (
    surface &&
    !structuredSessionSurfaceIsCurrent(host, sessionId, surface, runtime, result.committed)
  ) {
    return false
  }
  await host.close(sessionId, cause)
  return result.committed
}

export function captureInstalledStructuredSessionSurface(
  sessionId: string,
  runtime: StructuredSessionSurfaceRuntime
): StructuredSessionSurface | null {
  const host = getStructuredAgentSessionHost()
  return host ? captureStructuredSessionSurface(host, sessionId, runtime) : null
}
