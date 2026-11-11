import type { OrchestrationCompatibilityEvidence } from '../../../../../shared/orchestration/orchestration-compatibility-evidence'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationCompatibilityCallerAuthority } from '../../terminal-authority/orchestration-compatibility-authority'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { isEquivalentPaneKey } from '../../db/pane-key-match'

type RemintRuntime = Pick<
  OrcaRuntimeService,
  | 'getTerminalPaneKey'
  | 'getTerminalProcessIncarnation'
  | 'resolveTerminalHandleByProcessIncarnation'
>

export type RemintedWorkerReporter = {
  dispatchId: string
  handle: string
  paneKey: string
  processIncarnation: string
}

/**
 * A worker's env handle goes stale when a restarted runtime reissues the handle of its surviving PTY.
 * Recover the reporter only when its declared handle no longer names any terminal, its env names the
 * Dispatch's own pane, and the Dispatch's exact recorded process incarnation is still live in that pane.
 * A replacement process in the same pane has a new incarnation and is never recovered.
 */
export function resolveRemintedWorkerReporter(
  runtime: RemintRuntime,
  db: OrchestrationDb,
  args: { from: string; evidence: OrchestrationCompatibilityEvidence | undefined }
): RemintedWorkerReporter | null {
  const { from, evidence } = args
  if (!from.startsWith('term_') || runtime.getTerminalPaneKey(from)) {
    return null
  }
  // The caller's own env must name the stale handle and the Dispatch pane; scrubbed or foreign env proves nothing.
  if (evidence?.terminalHandle !== from || !evidence.paneKey) {
    return null
  }
  const dispatch = db.getActiveDispatchForIdentity(from)
  if (
    !dispatch ||
    dispatch.assignee_handle !== from ||
    !dispatch.assignee_pane_key ||
    !dispatch.process_incarnation ||
    !isEquivalentPaneKey(dispatch.assignee_pane_key, evidence.paneKey)
  ) {
    return null
  }
  const handle = runtime.resolveTerminalHandleByProcessIncarnation(
    dispatch.process_incarnation,
    dispatch.host_scope
  )
  if (!handle || handle === from) {
    return null
  }
  const paneKey = runtime.getTerminalPaneKey(handle)
  const processIncarnation = runtime.getTerminalProcessIncarnation(handle)
  if (
    !paneKey ||
    !processIncarnation ||
    !db.isDispatchProcessCurrent({ dispatchId: dispatch.id, paneKey, processIncarnation })
  ) {
    return null
  }
  return { dispatchId: dispatch.id, handle, paneKey, processIncarnation }
}

/**
 * The pane and process a terminal reporter speaks for. Attested hook identity wins; otherwise the
 * declared handle's own terminal; otherwise, for a restart-reissued handle, its exact-incarnation remint.
 * The incarnation is re-read at admission so a process replaced after entry is still refused.
 */
export function resolveWorkerReporterIdentity(
  runtime: RemintRuntime,
  db: OrchestrationDb,
  args: {
    from: string
    attested:
      | Pick<OrchestrationCompatibilityCallerAuthority, 'paneKey' | 'processIncarnation'>
      | undefined
    hasSessionCaller: boolean
    evidence: OrchestrationCompatibilityEvidence | undefined
  }
): { paneKey: string | null; processIncarnation: () => string | null } {
  const { from, attested } = args
  const declaredPaneKey = attested?.paneKey ?? runtime.getTerminalPaneKey(from)
  const remint = () =>
    args.hasSessionCaller || attested || declaredPaneKey
      ? null
      : resolveRemintedWorkerReporter(runtime, db, { from, evidence: args.evidence })
  const reminted = remint()
  return {
    paneKey: declaredPaneKey ?? reminted?.paneKey ?? null,
    processIncarnation: () =>
      attested?.processIncarnation ??
      (reminted
        ? (remint()?.processIncarnation ?? null)
        : runtime.getTerminalProcessIncarnation(from))
  }
}
