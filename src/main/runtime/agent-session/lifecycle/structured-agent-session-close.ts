import type { StructuredAgentSessionCloseWork } from '../../../native-chat/agent-session-wire/termination/structured-agent-session-close-work'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  observeStructuredSession,
  structuredSessionCloseSettled
} from '../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'

export type StructuredAgentSessionCloseOutcome = {
  stopped: boolean
  closeAttempted: boolean
  reason?: string
  /** The close cut a start whose acquire had not returned: true once that start has ended and its
   *  exit is proven, false when it ended without that proof. */
  whenStartEnds?: Promise<boolean>
}

export type StructuredSessionSurfaceRuntime = Pick<
  OrcaRuntimeService,
  | 'currentLocalStructuredSessionPresentation'
  | 'captureStructuredAgentSessionPresentation'
  | 'retireStructuredAgentSessionTabFromSnapshot'
  | 'removeCapturedStructuredSessionSavedTabs'
  | 'chatTabPerson'
  | 'chatTabPeople'
  | 'closeChatTabs'
>

export type StructuredSessionSurface = {
  tableId: string | null
  /** The teammate's own workspace it landed in: the host's tab is not this write's. */
  personList?: string
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
  /** The chat stops existing (it is deleted): its tab closes in every person's list. */
  chatGone?: true
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
      whenStartEnds: settleCancelledStart(
        host,
        sessionId,
        surface,
        options.runtime,
        options.chatGone
      )
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
  await retireClosedChatTabs(host, sessionId, surface, options.runtime, options.chatGone)
  return {
    stopped: true,
    closeAttempted: true,
    ...(wasStarting ? { reason: STARTING_AGENT_STOPPED_REASON } : {})
  }
}

export const STARTING_AGENT_STOPPED_REASON =
  'Its agent was still starting; Orca cancelled the start.'

export const STARTING_AGENT_STOPPING_REASON =
  'Its agent was still starting; Orca will close it as soon as it comes up.'

async function settleCancelledStart(
  host: StructuredAgentSessionHost,
  sessionId: string,
  surface: StructuredSessionSurface | null,
  runtime: StructuredSessionSurfaceRuntime | undefined,
  chatGone: true | undefined
): Promise<boolean> {
  try {
    await host.reads.startAttemptsEnded(sessionId)
    if (!structuredSessionCloseSettled(sessionId)) {
      return false
    }
    await retireClosedChatTabs(host, sessionId, surface, runtime, chatGone)
    return true
  } catch (error) {
    host.deps.logger.warn('settling a cancelled start failed', {
      scope: 'cancelled-start-close',
      sessionId,
      error
    })
    return false
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

/** A system close's tabs (rule 4, teammate-rules.ts). A chat that is gone closes in every list that
 *  holds it, each by its person: the owner's (the host's list) and each teammate's. Otherwise it is
 *  for whom the chat was created, read from its stamp: a teammate's chat in their Home closes in
 *  their own list only, and the host's list and window keep whatever the owner opened. */
async function retireClosedChatTabs(
  host: StructuredAgentSessionHost,
  sessionId: string,
  surface: StructuredSessionSurface | null,
  runtime: StructuredSessionSurfaceRuntime | undefined,
  chatGone: true | undefined
): Promise<void> {
  const closed = !runtime
    ? { hostList: true }
    : chatGone
      ? await runtime.closeChatTabs({ people: runtime.chatTabPeople(sessionId), sessionId })
      : await runtime.closeChatTabs({ people: [runtime.chatTabPerson(sessionId)], sessionId })
  if (closed.hostList) {
    await retireCapturedStructuredSessionSurface(host, sessionId, surface, runtime)
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

export function captureInstalledStructuredSessionSurface(
  sessionId: string,
  runtime: StructuredSessionSurfaceRuntime
): StructuredSessionSurface | null {
  const host = getStructuredAgentSessionHost()
  return host ? captureStructuredSessionSurface(host, sessionId, runtime) : null
}
