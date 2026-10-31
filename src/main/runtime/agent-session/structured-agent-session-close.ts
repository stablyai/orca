// Share close/proof across orchestration and teardown; retain unproven sessions for retry.
// Only absent host ownership and a non-live lease after close prove exit.

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
  // Run after close issuance even when unsettled, or released dispatches retain redrive subscriptions.
  afterClose?: () => void
  // Restore visibility on unproven close unless the caller will delete the workspace regardless.
  restoreTabOnUnprovenClose?: boolean
  // Last word in the session lane before Stop; false refuses the close and restores the tab.
  admitClose?: () => boolean
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
    await host.close(sessionId, 'evict', options.admitClose)
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

// Restore prior visibility only while exit is unproven; reobserve across the write to catch racing exits.
// Never replace the actionable close failure; missing identity after exit is expected.
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
