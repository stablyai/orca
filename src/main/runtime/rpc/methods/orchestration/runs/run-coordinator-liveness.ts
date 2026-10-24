import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RunRow } from '../../../../orchestration/types'
import {
  mailboxAddressOf,
  runBoundToCoordinator,
  runCoordinatorKey,
  type OrchestrationCoordinatorKey
} from '../../../../orchestration/orchestration-caller-identity'
import { readAgentSessionRecordStore } from '../../../../orchestration/structured-session-lineage'
import {
  lookupOrcaAgentSession,
  structuredSessionMailReach
} from '../../../../orchestration/structured-session-mail-address'
import { splitWorktreeId } from '../../../../../../shared/worktree/id'

// Why: a binding that keeps moving under a probe is contention, not something to win by retrying forever.
const PROBE_ATTEMPTS = 3

type BindParams = Parameters<OrchestrationDb['bindRun']>[0]

/**
 * Probe the Run's coordinator, then bind with what was probed so bindRun can refuse a live one.
 * When the binding moved between probe and transaction, probe again; after a few tries the refusal
 * stands and says to retry, so a bind never displaces a coordinator nobody probed.
 */
export async function bindAfterProbe(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  params: () => Omit<BindParams, 'probed'>
): Promise<RunRow | undefined> {
  for (let attempt = 1; ; attempt++) {
    const bind = params()
    const target = db.getRunRaw(bind.runId)
    const caller = {
      terminalHandle: bind.coordinatorHandle,
      paneKey: bind.coordinatorPaneKey,
      orcaSessionId: bind.coordinatorOrcaSessionId ?? null
    }
    const coordinator = target ? runCoordinatorKey(target) : null
    const liveLabel =
      coordinator && target && !runBoundToCoordinator(target, caller)
        ? await liveCoordinatorLabel(runtime, db, coordinator)
        : null
    try {
      return db.bindRun({ ...bind, ...(coordinator ? { probed: { coordinator, liveLabel } } : {}) })
    } catch (error) {
      if (
        attempt >= PROBE_ATTEMPTS ||
        !(error instanceof OrchestrationError) ||
        error.code !== 'run_binding_changed'
      ) {
        throw error
      }
    }
  }
}

/**
 * How a user recognizes the coordinator, when there is positive evidence it is still open; else null.
 * Only proof counts: a closed chat, an exited or unhooked terminal agent, another host, or anything
 * that cannot be checked reads as not open, so a restart handoff never needs a flag.
 */
async function liveCoordinatorLabel(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  key: OrchestrationCoordinatorKey
): Promise<string | null> {
  const address = mailboxAddressOf(key)
  if (key.orcaSessionId !== null) {
    // Why: the record store opens lazily, as for a send naming a session.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    const store = readAgentSessionRecordStore()
    const found = store ? lookupOrcaAgentSession(store, key.orcaSessionId) : null
    if (!store || found?.kind !== 'found') {
      return null
    }
    const reach = structuredSessionMailReach(store, found.record, db)
    if (reach.kind !== 'reachable') {
      return null
    }
    return `the chat${inWorktree(reach.session.location.workspaceId)} (${address})`
  }
  if (key.paneKey === null || (await runtime.coordinatorAgentPresence(key.paneKey)) !== 'live') {
    return null
  }
  const worktreeId = key.terminalHandle
    ? runtime.getTerminalWorktreeIdForPaneKey(key.paneKey)
    : null
  return `the terminal${inWorktree(worktreeId ?? undefined)} (${address})`
}

function inWorktree(worktreeId: string | undefined): string {
  const path = worktreeId ? splitWorktreeId(worktreeId)?.worktreePath : undefined
  const name = path?.split(/[\\/]/).findLast(Boolean)
  return name ? ` in ${name}` : ''
}
