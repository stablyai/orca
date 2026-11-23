import type { StructuredAgentSessionCloseWork } from '../../../native-chat/agent-session-wire/termination/structured-agent-session-close-work'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { runsForBot } from '../../../bots/bot-session-tabs'
import type { StructuredAgentSessionCloseCause } from '../../../native-chat/agent-session-wire/termination/structured-agent-session-host-lifetime'
import {
  observeStructuredSession,
  structuredSessionCloseSettled
} from '../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'

export type StructuredAgentSessionCloseOutcome = {
  stopped: boolean
  closeAttempted: boolean
  reason?: string
  /** The close cut a start whose acquire had not returned: stopped once that start has ended and its
   *  exit is proven; otherwise why not. */
  whenStartEnds?: Promise<{ stopped: true } | { stopped: false; reason: string }>
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
  admitClose?: (work: StructuredAgentSessionCloseWork) => boolean
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
  const startingOrWindingDown = () =>
    host.reads.agentStarting(sessionId) || host.reads.startWindingDown(sessionId)
  const wasStarting = startingOrWindingDown()
  let admitted = admitClose === undefined
  let closeFailure: string | undefined
  try {
    await host.close(
      sessionId,
      'evict',
      admitClose
        ? (work) => {
            admitted = admitClose(work)
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
  if (
    admitted &&
    // A start may also have registered after that read, before this close's lane cut it.
    (wasStarting || startingOrWindingDown()) &&
    closeFailure === undefined &&
    !structuredSessionCloseSettled(sessionId)
  ) {
    // The aborted start refuses its late child, but an acquire may return long after: never wait on it.
    return {
      stopped: false,
      closeAttempted: true,
      reason: STARTING_AGENT_STOPPING_REASON,
      whenStartEnds: settleCancelledStart(host, sessionId, surface, options.runtime)
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
  return {
    stopped: true,
    closeAttempted: true,
    ...(wasStarting ? { reason: STARTING_AGENT_STOPPED_REASON } : {})
  }
}

export const STARTING_AGENT_STOPPED_REASON =
  'Its agent was still starting; Orca cancelled the start.'

export const STARTING_AGENT_NEVER_FINISHED_REASON =
  'Its agent never finished starting; its process could not be proven gone.'

const STARTING_AGENT_EXIT_UNPROVEN_REASON =
  'Its agent was still starting when stopped; the start ended, but its exit was not proven.'

export const STARTING_AGENT_STOPPING_REASON =
  'Its agent was still starting; Orca will close it as soon as it comes up.'

async function settleCancelledStart(
  host: StructuredAgentSessionHost,
  sessionId: string,
  surface: StructuredSessionSurface | null,
  runtime: StructuredSessionSurfaceRuntime | undefined
): Promise<{ stopped: true } | { stopped: false; reason: string }> {
  try {
    if ((await host.reads.startAttemptsEnded(sessionId)) === 'ceiling') {
      return { stopped: false, reason: STARTING_AGENT_NEVER_FINISHED_REASON }
    }
    if (!structuredSessionCloseSettled(sessionId)) {
      return { stopped: false, reason: STARTING_AGENT_EXIT_UNPROVEN_REASON }
    }
    await retireCapturedStructuredSessionSurface(host, sessionId, surface, runtime)
    return { stopped: true }
  } catch (error) {
    host.deps.logger.warn('settling a cancelled start failed', {
      scope: 'cancelled-start-close',
      sessionId,
      error
    })
    return { stopped: false, reason: STARTING_AGENT_EXIT_UNPROVEN_REASON }
  }
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

/** Bookkeeping cannot invalidate native proof or reach a surface created after admission.
 *  `background`: the chat keeps working with no tab, so it stays open. */
export async function retireCapturedStructuredSessionSurface(
  host: StructuredAgentSessionHost,
  sessionId: string,
  surface: StructuredSessionSurface | null,
  runtime?: StructuredSessionSurfaceRuntime,
  background = false
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
      ...(background ? { background } : {}),
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
  runtime: StructuredSessionSurfaceRuntime & Partial<Pick<OrcaRuntimeService, 'bots'>>
): Promise<boolean> {
  if (surface && !structuredSessionSurfaceIsCurrent(host, sessionId, surface, runtime)) {
    return false
  }
  // A bot's thread or run keeps working when its tab closes; it waits in the bot's Activity.
  const keepRunning =
    cause === 'user-close' && runtime.bots !== undefined && runsForBot(runtime.bots, sessionId)
  const result = await retireCapturedStructuredSessionSurface(
    host,
    sessionId,
    surface,
    runtime,
    keepRunning
  )
  if (
    surface &&
    !structuredSessionSurfaceIsCurrent(host, sessionId, surface, runtime, result.committed)
  ) {
    return false
  }
  if (!keepRunning) {
    await host.close(sessionId, cause)
  }
  return result.committed
}

export function captureInstalledStructuredSessionSurface(
  sessionId: string,
  runtime: StructuredSessionSurfaceRuntime
): StructuredSessionSurface | null {
  const host = getStructuredAgentSessionHost()
  return host ? captureStructuredSessionSurface(host, sessionId, runtime) : null
}
