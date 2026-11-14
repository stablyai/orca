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

/** The Dispatch identity recorded for a handle, from whichever store owns it: a local Dispatch or a
 *  federated attachment this host runs for another computer's Run. */
type RecordedReporter = {
  dispatchId: string
  store: 'local' | 'remote'
  active: boolean
  paneKey: string | null
  processIncarnation: string | null
  hostScope: string | null
}

function recordedReporter(
  db: OrchestrationDb,
  handle: string,
  candidateDispatchId: string | undefined
): RecordedReporter | null {
  // Same order as admission: the handle's working Dispatch, else the last one it finished.
  const dispatch =
    db.getActiveDispatchForIdentity(handle) ?? db.getLatestDispatchForTerminal(handle)
  const local: RecordedReporter | null = dispatch
    ? {
        dispatchId: dispatch.id,
        store: 'local',
        active: dispatch.status === 'pending' || dispatch.status === 'dispatched',
        paneKey: dispatch.assignee_pane_key,
        processIncarnation: dispatch.process_incarnation,
        hostScope: dispatch.host_scope
      }
    : null
  const attachment = db.findLatestRemoteAttachmentForTerminal(handle)
  const remote: RecordedReporter | null = attachment
    ? {
        dispatchId: attachment.dispatch_id,
        store: 'remote',
        active: Boolean(
          attachment.pane_key &&
          db.findActiveRemoteAttachmentForPane(attachment.pane_key)?.dispatch_id ===
            attachment.dispatch_id
        ),
        paneKey: attachment.pane_key,
        processIncarnation: attachment.process_incarnation,
        // The attachment records no host; its terminal resource records the one it attached on.
        hostScope: db.getWorkerTerminalResourceByOwner(attachment.dispatch_id)?.host_scope ?? null
      }
    : null
  if (local && remote) {
    // One handle recorded in both stores: only a single working owner is unambiguous, unless the
    // request names a server-owned record of this handle's own local Dispatch. That only selects the
    // candidate; every identity and custody check below still decides.
    if (local.active !== remote.active) {
      return local.active ? local : remote
    }
    return candidateDispatchId && candidateDispatchId === local.dispatchId ? local : null
  }
  return local ?? remote
}

/** Whether the pane still belongs to this Dispatch, as its current handle would resolve it. */
function ownsPaneNow(
  db: OrchestrationDb,
  recorded: RecordedReporter,
  handle: string,
  paneKey: string
): boolean {
  const activeLocal = db.getActiveDispatchForIdentity(handle, paneKey)
  const activeRemote = db.findActiveRemoteAttachmentForPane(paneKey)
  if (recorded.active) {
    return recorded.store === 'local'
      ? activeLocal?.id === recorded.dispatchId && !activeRemote
      : activeRemote?.dispatch_id === recorded.dispatchId && !activeLocal
  }
  if (activeLocal || activeRemote) {
    return false
  }
  return recorded.store === 'local'
    ? db.getLatestDispatchForTerminal(handle, paneKey)?.id === recorded.dispatchId
    : db.findLatestRemoteAttachmentForPane(paneKey)?.dispatch_id === recorded.dispatchId
}

/**
 * A worker's env handle goes stale when a restarted runtime reissues the handle of its surviving PTY.
 * Recover the reporter only when its declared handle no longer names any terminal, its env names that
 * handle and the Dispatch's own pane, the Dispatch's exact recorded process incarnation is held by a
 * terminal on the recorded host in that pane, and no other Dispatch has since taken the pane.
 *
 * The env handle and pane are caller-selected consistency evidence, not OS caller authentication: the
 * profile's runtime token is the trust boundary, and any holder can already report as a worker's current
 * handle. The incarnation match proves identity continuity in the runtime's PTY records, not fresh
 * liveness. A replacement process in the same pane has a new incarnation and is never recovered.
 */
export function resolveRemintedWorkerReporter(
  runtime: RemintRuntime,
  db: OrchestrationDb,
  args: {
    from: string
    evidence: OrchestrationCompatibilityEvidence | undefined
    /** A local Dispatch the request names through a server-owned record, such as its resumed question. */
    candidateDispatchId?: string
  }
): RemintedWorkerReporter | null {
  const { from, evidence } = args
  if (!from.startsWith('term_') || runtime.getTerminalPaneKey(from)) {
    return null
  }
  // Missing or mismatched env is not a consistent caller context, so nothing is recovered.
  if (evidence?.terminalHandle !== from || !evidence.paneKey) {
    return null
  }
  const recorded = recordedReporter(db, from, args.candidateDispatchId)
  if (
    !recorded?.paneKey ||
    !recorded.processIncarnation ||
    !isEquivalentPaneKey(recorded.paneKey, evidence.paneKey)
  ) {
    return null
  }
  const handle = runtime.resolveTerminalHandleByProcessIncarnation(
    recorded.processIncarnation,
    recorded.hostScope
  )
  if (!handle || handle === from) {
    return null
  }
  const paneKey = runtime.getTerminalPaneKey(handle)
  const processIncarnation = runtime.getTerminalProcessIncarnation(handle)
  if (!paneKey || !processIncarnation) {
    return null
  }
  const current = { dispatchId: recorded.dispatchId, paneKey, processIncarnation }
  const exact =
    recorded.store === 'local'
      ? db.isDispatchProcessCurrent(current)
      : db.isRemoteAttachmentProcessCurrent(current)
  if (!exact || !ownsPaneNow(db, recorded, handle, paneKey)) {
    return null
  }
  return { dispatchId: recorded.dispatchId, handle, paneKey, processIncarnation }
}

/**
 * A handle no terminal answers to (no pane and no process) whose own recorded Dispatch or attachment
 * pinned a process. Only exact-incarnation recovery may speak for it; a headless terminal still has a
 * process, and a legacy record without an incarnation pinned none.
 */
function isRecordedStaleWorkerHandle(
  runtime: RemintRuntime,
  db: OrchestrationDb,
  from: string
): boolean {
  if (
    !from.startsWith('term_') ||
    runtime.getTerminalPaneKey(from) ||
    runtime.getTerminalProcessIncarnation(from)
  ) {
    return false
  }
  const local = db.getActiveDispatchForIdentity(from) ?? db.getLatestDispatchForTerminal(from)
  return Boolean(
    local?.process_incarnation ||
    db.findLatestRemoteAttachmentForTerminal(from)?.process_incarnation
  )
}

/**
 * The pane and process a terminal reporter speaks for. Attested hook identity wins; otherwise the
 * declared handle's own terminal; otherwise, for a restart-reissued handle, its exact-incarnation remint.
 * The remint is re-resolved at admission so a process replaced or a pane taken after entry is refused.
 */
export function resolveWorkerReporterIdentity(
  runtime: RemintRuntime,
  db: OrchestrationDb,
  args: {
    from: string
    /** The hook-attested caller, which speaks for `from` only when it names that same handle. */
    authority:
      | Pick<
          OrchestrationCompatibilityCallerAuthority,
          'terminalHandle' | 'paneKey' | 'processIncarnation'
        >
      | undefined
    hasSessionCaller: boolean
    evidence: OrchestrationCompatibilityEvidence | undefined
    candidateDispatchId?: string
  }
): {
  paneKey: string | null
  processIncarnation: () => string | null
  /** The Dispatch a restart-reissued handle was recovered to at entry; the request stays pinned to it. */
  recovered: RemintedWorkerReporter | null
  /** A known stale worker handle that recovery could not prove: no weaker handle or pane lookup may
   *  stand in for it. */
  unrecoveredStaleWorker: () => boolean
} {
  const { from } = args
  // Why: attested hook identity survives graph remount; caller params never supply lifecycle authority.
  const attested = args.authority?.terminalHandle === from ? args.authority : undefined
  const declaredPaneKey = attested?.paneKey ?? runtime.getTerminalPaneKey(from)
  const remint = () =>
    args.hasSessionCaller || attested || declaredPaneKey
      ? null
      : resolveRemintedWorkerReporter(runtime, db, {
          from,
          evidence: args.evidence,
          candidateDispatchId: args.candidateDispatchId
        })
  const reminted = remint()
  // The re-read must still speak for the same Dispatch, pane and process that routing already used, so a
  // record rewritten to another incarnation after entry cannot carry the request over to it.
  const remintedAgain = (entry: RemintedWorkerReporter): string | null => {
    const again = remint()
    return again?.dispatchId === entry.dispatchId &&
      isEquivalentPaneKey(again.paneKey, entry.paneKey) &&
      again.processIncarnation === entry.processIncarnation
      ? again.processIncarnation
      : null
  }
  return {
    paneKey: declaredPaneKey ?? reminted?.paneKey ?? null,
    processIncarnation: () =>
      attested?.processIncarnation ??
      (reminted ? remintedAgain(reminted) : runtime.getTerminalProcessIncarnation(from)),
    recovered: reminted,
    unrecoveredStaleWorker: () =>
      !reminted &&
      !args.hasSessionCaller &&
      !attested &&
      !declaredPaneKey &&
      isRecordedStaleWorkerHandle(runtime, db, from)
  }
}
