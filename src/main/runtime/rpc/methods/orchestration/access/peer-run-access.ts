import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import {
  isPeerCoordinatorAddress,
  type OrchestrationPeerCaller
} from '../../../../orchestration/addressing/orchestration-caller-identity'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { parseOrcaSessionAddress } from '../../../../../../shared/orca-session-address'
import type { RpcContext } from '../../../core'
import { resolveDispatchCreator } from '../runs/dispatch-creator'
import type {
  OrchestrationMethodAccessDeclaration,
  OrchestrationSubjectKind
} from './orchestration-method-access'

const NO_EFFECTS = { effectsApplied: false } as const

/** Kinds named by an ID: one this Orca does not have is in no Run, and the method answers it as
 *  not found. Addresses also name terminals and sessions that work in no Run, so they must resolve. */
const ID_KINDS: ReadonlySet<OrchestrationSubjectKind> = new Set([
  'dispatch',
  'task',
  'message',
  'gate'
])

/**
 * A paired Orca changes only the Run it coordinates here: every subject a write names must be in
 * that Run. Reads are not fenced, since the pairing already reads all of this Orca; a collection
 * that names no Run reads the paired Orca's own, as a coordinator's does. Calls that act on this
 * Orca as a whole are this Orca's own. Returns the params the method runs with.
 */
export function checkPeerAccess<P>(
  access: OrchestrationMethodAccessDeclaration,
  params: P,
  db: OrchestrationDb,
  peer: OrchestrationPeerCaller
): P {
  const { run_id: runId, home_label: label } = peer.peerRun
  if (access.kind === 'localOnly') {
    throw new OrchestrationError(
      'forbidden',
      `This command acts on this server as a whole, so only this server can run it, not ${label}. No effects were applied.`,
      NO_EFFECTS
    )
  }
  const values: Record<string, unknown> =
    params && typeof params === 'object' ? { ...(params as Record<string, unknown>) } : {}
  for (const [field, kind] of access.kind === 'reads' ? [] : Object.entries(access.targets)) {
    for (const subject of subjectsOf(values[field])) {
      const subjectRunId = kind && resolveSubjectRunId(db, kind, subject, peer)
      if (kind && subjectRunId !== runId && !(subjectRunId === undefined && ID_KINDS.has(kind))) {
        throw new OrchestrationError(
          'forbidden',
          `${subject} is not in the Run ${label} coordinates here. No effects were applied.`,
          NO_EFFECTS
        )
      }
    }
  }
  const runField = access.collection
    ? Object.entries(access.targets).find(([, kind]) => kind === 'run')?.[0]
    : undefined
  // The paired Orca's forwarded lists drop its own Run ID, which names nothing here.
  if (runField && values[runField] === undefined) {
    values[runField] = runId
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same params with at most the declared Run field set to a string, which every Run field accepts.
  return (params && typeof params === 'object' ? values : params) as P
}

function subjectsOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value !== 'string' || value === '') {
    return []
  }
  if (!value.startsWith('[') && !value.startsWith('{')) {
    return [value]
  }
  // A JSON list of IDs (`--deps`), or send's JSON payload, which names its Dispatch by `dispatchId`.
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return [value]
  }
  if (Array.isArray(parsed)) {
    return subjectsOf(parsed)
  }
  const dispatchId =
    parsed && typeof parsed === 'object' && 'dispatchId' in parsed ? parsed.dispatchId : undefined
  return typeof dispatchId === 'string' ? [dispatchId] : []
}

/** The Run a subject belongs to on this Orca, or undefined when it names nothing here. */
export function resolveSubjectRunId(
  db: OrchestrationDb,
  kind: OrchestrationSubjectKind,
  subject: string,
  peer: OrchestrationPeerCaller
): string | undefined {
  switch (kind) {
    case 'run':
      return subject
    case 'dispatch':
      return db.getDispatchContextById(subject)?.run_id
    case 'task':
      return db.getTask(subject)?.run_id
    case 'message':
      return db.getMessageById(subject)?.run_id
    case 'gate':
      return db.getGate(subject)?.run_id
    case 'request':
      // Receipts are keyed by the pairing, so they are its own; the same paired Orca may read another of its Runs' receipts.
      return peer.peerRun.run_id
    case 'worker':
    case 'session':
      return assigneeRunId(db, subject)
    case 'party':
      return partyRunId(db, subject, peer)
    case 'conversation':
    case 'sessionLink':
      return undefined
  }
}

function partyRunId(
  db: OrchestrationDb,
  address: string,
  peer: OrchestrationPeerCaller
): string | undefined {
  if (address === peer.address) {
    return peer.peerRun.run_id
  }
  if (address.startsWith('run:')) {
    return address.slice('run:'.length)
  }
  if (address.startsWith('dispatch:')) {
    return db.getDispatchContextById(address.slice('dispatch:'.length))?.run_id
  }
  // A group spans Runs, so it never resolves into one.
  return address.startsWith('@') ? undefined : assigneeRunId(db, address)
}

/** The Run of the newest Dispatch a terminal, pane or session was given. */
function assigneeRunId(db: OrchestrationDb, subject: string): string | undefined {
  const session = parseOrcaSessionAddress(subject) ?? subject
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of one column returns exactly that column.
  const row = db.db
    .prepare(
      `SELECT run_id FROM dispatch_contexts
       WHERE assignee_handle = ?1 OR assignee_pane_key = ?1 OR assignee_orca_session_id = ?2
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(subject, session) as { run_id: string } | undefined
  return row?.run_id
}

/** Only a paired Orca's own frames speak as it: its address is predictable, so no other caller may
 *  declare it as its handle or pane and read or bind its Run's mail. */
export function refusePeerAddressClaim(declared: string | undefined): void {
  if (isPeerCoordinatorAddress(declared)) {
    throw new OrchestrationError(
      'forbidden',
      `${declared} is a paired Orca's coordinator address, and only that Orca can act as it. No effects were applied.`,
      NO_EFFECTS
    )
  }
}

/** Pairing is one-way: work running in a paired Orca's Run, its helpers' included, never calls on
 *  to another server, and neither does that Orca through this one. */
export function refuseServerCallFromPeerRun(
  ctx: RpcContext,
  callerHandle: string | undefined
): void {
  const db = ctx.runtime.getOrchestrationDb()
  const caller = ctx.orchestrationCaller
  // Most servers coordinate no paired Orca's Run, and then the creator lookup (which can refuse) is skipped.
  const peerRun =
    caller?.kind === 'peer'
      ? caller.peerRun
      : db.hasPeerRuns()
        ? peerRunOfCallerWork(ctx, db, callerHandle)
        : undefined
  if (peerRun) {
    throw new OrchestrationError(
      'forbidden',
      `This work is coordinated from ${peerRun.home_label}, so it cannot use --on. Ask that coordinator instead. No effects were applied.`,
      NO_EFFECTS
    )
  }
}

function peerRunOfCallerWork(
  ctx: RpcContext,
  db: OrchestrationDb,
  callerHandle: string | undefined
): ReturnType<OrchestrationDb['getPeerRun']> {
  const creator = resolveDispatchCreator(ctx.runtime, callerHandle, ctx.orchestrationCaller)
  const dispatchId = db.resolveCreatorDispatchId(creator)
  const runId = dispatchId ? db.getDispatchContextById(dispatchId)?.run_id : undefined
  return runId ? db.getPeerRun(runId) : undefined
}
