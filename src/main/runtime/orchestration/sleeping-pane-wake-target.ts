import {
  mayBackgroundWakeSleepingAgentSession,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { SleepingPaneWakeRequest } from './sleeping-pane-wake-scheduler'

export type SleepingPaneWakeLookups = {
  /** Remint-stable coordinator identity for a run mailbox. */
  getRunCoordinatorPaneKey: (runId: string) => string | undefined
  /** Assignee identity for a dispatch mailbox, including remote attachments. */
  getDispatchAssigneePaneKey: (dispatchId: string) => string | undefined
  /** Pane identity a still-registered handle record remembers. */
  getPaneKeyForHandle: (handle: string) => string | null | undefined
  getSleepingRecord: (paneKey: string) => SleepingAgentSessionRecord | undefined
}

export type SleepingPaneWakeRefusal =
  | 'no-pane-identity'
  | 'no-tab-identity'
  | 'not-slept'
  | 'user-slept'

export type SleepingPaneWakeResolution =
  | { ok: true; request: SleepingPaneWakeRequest }
  | { ok: false; reason: SleepingPaneWakeRefusal }

function resolvePaneKey(mailboxHandle: string, lookups: SleepingPaneWakeLookups): string | null {
  if (mailboxHandle.startsWith('run:')) {
    return lookups.getRunCoordinatorPaneKey(mailboxHandle.slice('run:'.length)) ?? null
  }
  if (mailboxHandle.startsWith('dispatch:')) {
    return lookups.getDispatchAssigneePaneKey(mailboxHandle.slice('dispatch:'.length)) ?? null
  }
  return lookups.getPaneKeyForHandle(mailboxHandle) ?? null
}

/**
 * Which pane an undeliverable mailbox belongs to, and whether inbound mail may
 * wake it. Every message type resolves the same way — the arriving message IS
 * the evidence the pane is owed something, so there is deliberately no type
 * filter here (see the r4 plan).
 */
export function resolveSleepingPaneWakeTarget(
  mailboxHandle: string,
  lookups: SleepingPaneWakeLookups
): SleepingPaneWakeResolution {
  const paneKey = resolvePaneKey(mailboxHandle, lookups)
  if (!paneKey) {
    return { ok: false, reason: 'no-pane-identity' }
  }
  const record = lookups.getSleepingRecord(paneKey)
  if (!record) {
    return { ok: false, reason: 'not-slept' }
  }
  if (!mayBackgroundWakeSleepingAgentSession(record)) {
    return { ok: false, reason: 'user-slept' }
  }
  // The resolved pane key is the routing authority and may carry a reminted tab
  // newer than persistence. It also recovers legacy records with no tabId.
  const tabId = parsePaneKey(paneKey)?.tabId
  if (!tabId) {
    return { ok: false, reason: 'no-tab-identity' }
  }
  return {
    ok: true,
    request: {
      paneKey,
      worktreeId: record.worktreeId,
      tabId
    }
  }
}
