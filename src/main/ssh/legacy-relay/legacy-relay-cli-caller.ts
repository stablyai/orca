/**
 * Who a relay-era terminal's `orca` command speaks as, and what it may reach.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 *
 * Everything the host sends is a claim. The caller is accepted only as a pane this desktop leased
 * on that host, which its relay still runs, and which this desktop's orchestration records bind to
 * the claimed handle (as a Dispatch assignee or a Run coordinator). It then reaches only its own
 * mailboxes, its own Dispatch or Run, and the other party of that same orchestration.
 */
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { OrchestrationDb } from '../../runtime/orchestration/db'
import { isEquivalentPaneKey } from '../../runtime/orchestration/db/pane-key-match'
import type { DispatchContextRow, RunRow } from '../../runtime/orchestration/types'
import type { LegacyRelayLivePane } from './legacy-relay-bridge-leases'

const MAX_IDENTITY_LENGTH = 512

export const LEGACY_RELAY_CLI_UNVERIFIED =
  "Orca could not confirm this terminal is one of this host's supervised Orca terminals, so its " +
  'orca command was refused. Run it in a new terminal on this host.'

export type LegacyRelayCliCaller = {
  handle: string
  paneKey: string
  ptyId: string
  processIncarnation?: string
  /** The Dispatch this pane holds as its assignee. */
  dispatch?: DispatchContextRow
  /** A settled legacy Dispatch this pane may name only to replay a result it committed. */
  replayDispatch?: DispatchContextRow
  /** The Run this pane coordinates. */
  run?: RunRow
}

export type LegacyRelayCliCall = { method: string; params: Record<string, unknown> }

function bounded(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length <= MAX_IDENTITY_LENGTH ? trimmed : undefined
}

function samePane(recorded: string | null | undefined, paneKey: string): boolean {
  return recorded ? isEquivalentPaneKey(recorded, paneKey) : false
}

export function resolveLegacyRelayCliCaller(
  runtime: OrcaRuntimeService,
  env: Readonly<Record<string, string>>,
  livePane: (paneKey: string) => LegacyRelayLivePane | null,
  targetId: string,
  /** A retry of a mutation this caller already completed, which may outlive its Dispatch. */
  replay?: { fingerprint: string; requestId: string }
): LegacyRelayCliCaller {
  const handle = bounded(env.ORCA_TERMINAL_HANDLE)
  const paneKey = bounded(env.ORCA_PANE_KEY)
  const pane = handle && paneKey && parsePaneKey(paneKey) ? livePane(paneKey) : null
  if (!handle || !paneKey || !pane) {
    throw new Error(LEGACY_RELAY_CLI_UNVERIFIED)
  }
  // The relay names the handle it launched the pane with; a different claim is someone else's.
  if (pane.terminalHandle && pane.terminalHandle !== handle) {
    throw new Error(LEGACY_RELAY_CLI_UNVERIFIED)
  }
  // A handle this runtime hosts elsewhere belongs to that terminal, never to a relay pane.
  const hostedPane = runtime.getTerminalPaneKey(handle)
  if (hostedPane && !isEquivalentPaneKey(hostedPane, paneKey)) {
    throw new Error(LEGACY_RELAY_CLI_UNVERIFIED)
  }
  const db = runtime.getOrchestrationDb()
  const own = (row: DispatchContextRow | undefined) =>
    row?.assignee_handle === handle && samePane(row.assignee_pane_key, paneKey) ? row : undefined
  const active = own(db.getActiveDispatchForIdentity(handle, paneKey))
  const replayed =
    replay && db.getMutationReceipt(replay.fingerprint, replay.requestId)?.state === 'completed'
  const dispatch = active ?? (replayed ? own(db.getLatestDispatchForTerminal(handle)) : undefined)
  const replayDispatch = replay
    ? own(settledLegacyDispatch(db, handle, paneKey, replay.requestId))
    : undefined
  const run = resolveCoordinatedRun(db, handle, paneKey, targetId)
  if (!dispatch && !replayDispatch && !run) {
    throw new Error(LEGACY_RELAY_CLI_UNVERIFIED)
  }
  return {
    handle,
    paneKey,
    ptyId: pane.ptyId,
    ...(pane.incarnationId ? { processIncarnation: `${pane.ptyId}:${pane.incarnationId}` } : {}),
    ...(dispatch ? { dispatch } : {}),
    ...(replayDispatch ? { replayDispatch } : {}),
    ...(run ? { run } : {})
  }
}

/** A legacy worker's results live in legacy receipts, under the principal it settled as. */
function settledLegacyDispatch(
  db: OrchestrationDb,
  handle: string,
  paneKey: string,
  requestId: string
): DispatchContextRow | undefined {
  const adoption = db.getLegacyAdoption()
  const principal = adoption
    ? db.resolveLegacyCompatibilityPrincipalByIdentity({
        runId: adoption.adopted_run_id,
        role: 'worker',
        paneKey
      })
    : undefined
  // Replay only operations this settled principal committed with this request id.
  return principal?.status === 'settled' &&
    principal.terminal_handle === handle &&
    principal.dispatch_id &&
    db.getLegacyOperationReceipt(principal.id, `invocation:${requestId}`)
    ? db.getDispatchContextById(principal.dispatch_id)
    : undefined
}

/** Only committed principals bind migrated coordinators to exact host/pane identities; host-attested callers cannot use first-caller-wins adoption. */
function resolveCoordinatedRun(
  db: OrchestrationDb,
  handle: string,
  paneKey: string,
  targetId: string
): RunRow | undefined {
  const bound = db.getCurrentRunForPane(paneKey)
  if (bound) {
    return bound.coordinator_handle === handle ? bound : undefined
  }
  const adopted = db.getLegacyAdoption()?.adopted_run_id
  const principal = adopted ? db.getLegacyCoordinatorPrincipal(adopted) : undefined
  return adopted &&
    principal?.status === 'committed' &&
    principal.terminal_handle === handle &&
    samePane(principal.pane_key, paneKey) &&
    principalHostTargetId(principal.host_scope) === targetId &&
    db.resolveLegacyCoordinatorCandidate({ runId: adopted, terminalHandle: handle, paneKey })
    ? db.getRun(adopted)
    : undefined
}

/** The SSH target a committed principal attested from; a pane key alone is not unique per host. */
function principalHostTargetId(hostScope: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(hostScope)
    return parsed &&
      typeof parsed === 'object' &&
      'kind' in parsed &&
      parsed.kind === 'ssh' &&
      'targetId' in parsed &&
      typeof parsed.targetId === 'string'
      ? parsed.targetId
      : undefined
  } catch {
    return undefined
  }
}

function outside(subject: string): Error {
  return new Error(
    `A terminal started by an older version of Orca can reach only its own orchestration, and ${subject} is outside it.`
  )
}

function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function payloadDispatchId(payload: string | undefined): string | undefined {
  if (!payload) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && 'dispatchId' in parsed
      ? typeof parsed.dispatchId === 'string'
        ? parsed.dispatchId
        : undefined
      : undefined
  } catch {
    // The handler owns malformed payloads; nothing here names a Dispatch.
    return undefined
  }
}

/** A Dispatch the caller is a party to: its own, or one in the Run it coordinates on this host. */
function isPartyDispatch(
  db: OrchestrationDb,
  caller: LegacyRelayCliCaller,
  dispatchId: string,
  livePane: (paneKey: string) => LegacyRelayLivePane | null
): boolean {
  if (dispatchId === caller.dispatch?.id || dispatchId === caller.replayDispatch?.id) {
    return true
  }
  const named = db.getDispatchContextById(dispatchId)
  return Boolean(
    caller.run &&
    named?.run_id === caller.run.id &&
    named.assignee_pane_key &&
    livePane(named.assignee_pane_key)
  )
}

function ownedAddresses(caller: LegacyRelayCliCaller): Set<string> {
  return new Set([
    caller.handle,
    ...(caller.dispatch ? [`dispatch:${caller.dispatch.id}`] : []),
    ...(caller.run ? [`run:${caller.run.id}`] : [])
  ])
}

function isAllowedRecipient(
  db: OrchestrationDb,
  caller: LegacyRelayCliCaller,
  to: string,
  livePane: (paneKey: string) => LegacyRelayLivePane | null
): boolean {
  if (ownedAddresses(caller).has(to)) {
    return true
  }
  for (const dispatch of [caller.dispatch, caller.replayDispatch]) {
    const coordinator = dispatch ? db.getRun(dispatch.run_id)?.coordinator_handle : undefined
    if (
      dispatch &&
      (to === `run:${dispatch.run_id}` ||
        (dispatch.creator_handle && to === dispatch.creator_handle) ||
        (coordinator && to === coordinator) ||
        db.isLegacyCoordinatorDeliveryTarget(dispatch.run_id, to))
    ) {
      return true
    }
  }
  if (to.startsWith('dispatch:')) {
    return isPartyDispatch(db, caller, to.slice('dispatch:'.length), livePane)
  }
  const worker = caller.run ? db.getActiveDispatchForIdentity(to) : undefined
  return Boolean(worker && isPartyDispatch(db, caller, worker.id, livePane))
}

/** Constrain calls to this orchestration. Exact committed replays tolerate moved sender/Run/recipient after the original checks passed. */
export function assertLegacyRelayCliScope(
  db: OrchestrationDb,
  caller: LegacyRelayCliCaller,
  call: LegacyRelayCliCall,
  livePane: (paneKey: string) => LegacyRelayLivePane | null,
  exactReplay = false
): void {
  const { method, params } = call
  const selfParam = method === 'orchestration.check' || method === 'orchestration.inbox'
  const named = stringParam(params, selfParam ? 'terminal' : 'from')
  if (named !== caller.handle && (selfParam || !exactReplay)) {
    throw outside(`terminal '${named ?? ''}'`)
  }
  const run = stringParam(params, 'run')
  if (run && !exactReplay && run !== caller.dispatch?.run_id && run !== caller.run?.id) {
    throw outside(`run '${run}'`)
  }
  if (method === 'orchestration.reply') {
    const id = stringParam(params, 'id') ?? ''
    const original = db.getMessageById(id)
    if (!original || (!exactReplay && !ownedAddresses(caller).has(original.to_handle))) {
      throw outside(`message '${id}'`)
    }
    return
  }
  if ((method !== 'orchestration.send' && method !== 'orchestration.ask') || exactReplay) {
    return
  }
  const dispatchId = payloadDispatchId(stringParam(params, 'payload'))
  if (dispatchId && !isPartyDispatch(db, caller, dispatchId, livePane)) {
    throw outside(`dispatch '${dispatchId}'`)
  }
  const to = stringParam(params, 'to')
  if (to && !isAllowedRecipient(db, caller, to, livePane)) {
    throw outside(`recipient '${to}'`)
  }
}
