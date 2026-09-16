/**
 * Closing a structured agent session's provider child, and proving it went.
 *
 * Extracted from `stopStructuredWorker` so that orchestration settlement and worktree teardown
 * close a session the SAME way rather than one of them inventing a shorter version. Everything
 * dispatch-shaped — dropping the hold, the redrive subscription and the parked mail — stays with
 * the caller that has a dispatch; this is only the child.
 *
 * `host.close` returns void and keeps a failed close indexed for retry, so the only settlement
 * evidence is the observation AFTER it: a session the host no longer holds and whose lease is no
 * longer live is proven gone. Anything else is retained rather than settled.
 */

import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from './orca-runtime'
import { retireSettledStructuredWorkerTab } from './structured-agent-session-tab-retirement'
import { observeStructuredWorker } from './structured-worker-authority'

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
  /**
   * Runs after the close is issued and BEFORE the proof is read.
   *
   * Not after: an unsettled close returns early, so a dispatch that released its hold there would
   * keep the child un-evictable for the life of the app. Every settlement has to reach it.
   */
  afterClose?: () => void
  /**
   * Whether an unproven close may put the chat tab back in the durable restore index.
   *
   * On by default, which is the retryable case: a stop that refused and still took the user's tab
   * away is the loss the rollback exists to undo. A caller that will discard the WORKSPACE
   * whatever this close reports passes false — a tab put back there is a durable reference to a
   * workspace about to be gone, and it republishes the chat at the next launch pointing at it.
   */
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
  // Read BEFORE the hide, so a rollback puts the tab back exactly as it was. Restoring
  // unconditionally would publish a tab for a session that was already hidden — a worker started
  // without a chat tab, or one the user had closed — which is a new side effect, not an undo.
  const restoreTabIfCloseFails =
    options.restoreTabOnUnprovenClose !== false && readPersistedTabVisibility(host, sessionId)
  // Set only once the close is actually issued: `setSessionTabVisibility` throwing first leaves a
  // running child, and a receipt that still said `closed_agent_terminal` for it would be the
  // close-that-never-happened this flag exists to rule out.
  let closeAttempted = false
  try {
    await host.setSessionTabVisibility?.(sessionId, false)
    closeAttempted = true
    await host.close(sessionId)
  } catch (error) {
    // Only `closeAttempted` proves the hide landed: the store transaction restores its own state on
    // failure, so a `setSessionTabVisibility` that threw hid nothing and has nothing to undo.
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
  const observation = observeStructuredWorker({ sessionId })
  if (observation.status !== 'exited') {
    await restorePersistedTabVisibility(host, sessionId, restoreTabIfCloseFails)
    return {
      stopped: false,
      closeAttempted: true,
      reason: observation.reason ?? 'The structured session is still attached after close.'
    }
  }
  // Only past the proof, and structurally unable to throw: the session's chat tab is retired from
  // the live snapshot, which `setSessionTabVisibility(false)` above does not do.
  retireSettledStructuredWorkerTab(sessionId, options.runtime)
  return { stopped: true, closeAttempted: true }
}

function readPersistedTabVisibility(host: StructuredAgentSessionHost, sessionId: string): boolean {
  try {
    return host.getPersistedVisibleSessionTabIndex?.().sessionIds.includes(sessionId) ?? false
  } catch {
    // Unreadable index: claim nothing. A rollback that cannot prove the tab was visible must not
    // publish one, for the same reason the read exists at all.
    return false
  }
}

/**
 * Puts the chat tab back after a close that did not settle.
 *
 * The hide is the one visible side effect this function performs before the destructive step, so a
 * failed close that kept it left the user's chat tab gone from the durable restore index — the
 * conversation survived under `userData`, but nothing brought the tab back at the next launch.
 *
 * Re-observed first rather than restored outright: a close can throw PAST its own proof and still
 * have taken the child with it, and `closeStructuredSessionsForWorktree` reads exactly that,
 * counting such a session closed and retiring its tab. Republishing there would resurrect a tab for
 * a session that is demonstrably gone, at the next launch, pointing at a deleted workspace.
 *
 * That observation NARROWS the window; it does not close it. This one and the sweep's are taken a
 * store write apart, so a child that dies in between is unverifiable here and exited there — which
 * is why the sweep re-drops the tab reference when it takes that proof. Do not delete either half
 * on the strength of the other.
 *
 * Never throws: the caller's `reason` is what the user is asked to act on, and a rollback failure
 * must not replace it. `agent_session_identity_required` is the expected one — the record can be
 * gone by now, which is itself the exit this restore is declining to undo.
 */
async function restorePersistedTabVisibility(
  host: StructuredAgentSessionHost,
  sessionId: string,
  restoreTab: boolean
): Promise<void> {
  if (!restoreTab || observeStructuredWorker({ sessionId }).status === 'exited') {
    return
  }
  try {
    await host.setSessionTabVisibility?.(sessionId, true)
  } catch (error) {
    console.warn(
      `[structured-session-close] could not restore the chat tab for ${sessionId} after a failed close`,
      error
    )
  }
}
