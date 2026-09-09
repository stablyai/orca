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
  // Set only once the close is actually issued: `setSessionTabVisibility` throwing first leaves a
  // running child, and a receipt that still said `closed_agent_terminal` for it would be the
  // close-that-never-happened this flag exists to rule out.
  let closeAttempted = false
  try {
    await host.setSessionTabVisibility?.(sessionId, false)
    closeAttempted = true
    await host.close(sessionId)
  } catch (error) {
    return {
      stopped: false,
      closeAttempted,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  options.afterClose?.()
  const observation = observeStructuredWorker({ sessionId })
  if (observation.status !== 'exited') {
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
