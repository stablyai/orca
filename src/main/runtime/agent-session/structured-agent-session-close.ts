/** Share provider-child close/proof between orchestration and worktree teardown; callers retain dispatch cleanup. Only absent host ownership plus a non-live lease after close prove exit; retain unproven sessions for retry. */

import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../orca-runtime'
import { retireSettledStructuredWorkerTab } from './structured-agent-session-tab-retirement'
import {
  observeStructuredSession,
  structuredSessionCloseSettled
} from '../structured-worker-authority'

export type StructuredAgentSessionCloseOutcome = {
  stopped: boolean
  /** Whether a close was actually issued; a receipt must not claim one that never happened. */
  closeAttempted: boolean
  reason?: string
}

export type StructuredAgentSessionCloseOptions = {
  runtime?: Pick<
    OrcaRuntimeService,
    'forgetStructuredSessionMail' | 'retireStructuredAgentSessionTabFromSnapshot'
  >
  /** Run after close issuance but before proof, including unsettled closes, or released dispatches retain redrive subscriptions nudging unowned sessions. */
  afterClose?: () => void
  /** Default restores previously visible tabs after unproven close; false for callers deleting the workspace regardless, to avoid restoring tabs that point at deleted workspaces. */
  restoreTabOnUnprovenClose?: boolean
}

export async function closeStructuredAgentSessionChild(
  sessionId: string,
  options: StructuredAgentSessionCloseOptions = {}
): Promise<StructuredAgentSessionCloseOutcome> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    // Nothing was reached, so nothing was acted on; the receipt must not claim a close.
    return {
      stopped: false,
      closeAttempted: false,
      reason: 'The structured agent-session host is not installed; no session was closed.'
    }
  }
  // Capture visibility/id before hide so rollback restores only what existed, never an already-hidden worker/chat.
  const restoreTabIfCloseFails =
    options.restoreTabOnUnprovenClose !== false ? readPersistedTabId(host, sessionId) : null
  try {
    return await closeHiddenStructuredAgentSessionChild(
      host,
      sessionId,
      options,
      restoreTabIfCloseFails
    )
  } finally {
    // After the outcome, not at the hide: a close that puts the tab back leaves its chat working.
    host.notifySessionTabHidden?.(sessionId)
  }
}

async function closeHiddenStructuredAgentSessionChild(
  host: StructuredAgentSessionHost,
  sessionId: string,
  options: StructuredAgentSessionCloseOptions,
  restoreTabIfCloseFails: string | null
): Promise<StructuredAgentSessionCloseOutcome> {
  // Mark only issued closes; failed visibility writes leave live children and must not produce closed-agent receipts.
  let closeAttempted = false
  try {
    await host.setSessionTabVisibility?.(sessionId, false, undefined, { deferHiddenNotice: true })
    closeAttempted = true
    // A worktree teardown or an orchestration stop: not the user closing this chat.
    await host.close(sessionId, 'evict')
  } catch (error) {
    // Restore only after closeAttempted: failed hide transactions undo themselves.
    if (closeAttempted) {
      await restorePersistedTabVisibility(host, sessionId, restoreTabIfCloseFails)
    }
    return {
      stopped: false,
      closeAttempted,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  options.afterClose?.()
  if (!structuredSessionCloseSettled(sessionId)) {
    const observation = observeStructuredSession(sessionId)
    await restorePersistedTabVisibility(host, sessionId, restoreTabIfCloseFails)
    return {
      stopped: false,
      closeAttempted: true,
      reason: observation.reason ?? 'The structured session is still attached after close.'
    }
  }
  // After proven exit, retire live snapshot rows too; durable hide alone leaves them visible.
  retireSettledStructuredWorkerTab(sessionId, options.runtime)
  return { stopped: true, closeAttempted: true }
}

function readPersistedTabId(host: StructuredAgentSessionHost, sessionId: string): string | null {
  try {
    return host.deps.store.getSessionTabId(sessionId)
  } catch {
    // Unreadable visibility proves nothing; never restore a tab not known to have been visible.
    return null
  }
}

/** Restore prior visibility only while close remains unproven; close can throw after actual exit.
 * Reobserve here and in the sweep: a child may exit between these observations across the restore write.
 * Never throw or replace the actionable close failure; missing session identity is expected after exit. */
async function restorePersistedTabVisibility(
  host: StructuredAgentSessionHost,
  sessionId: string,
  tabId: string | null
): Promise<void> {
  if (tabId === null || structuredSessionCloseSettled(sessionId)) {
    return
  }
  try {
    await host.setSessionTabVisibility?.(sessionId, true, tabId)
  } catch (error) {
    host.deps.logger.warn('restoring the chat tab after a failed close failed', {
      scope: 'close-tab-restore',
      sessionId,
      error
    })
  }
}
