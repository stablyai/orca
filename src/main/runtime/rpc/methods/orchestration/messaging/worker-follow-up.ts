/** A message to a worker that finished becomes its next Task: worker-start run for the sender, on that same worker.
 *  Open workers take it in place, closed ones reopen in their saved conversation, and agents that keep none start fresh. */

import {
  agentProviderSessionsEqual,
  isResumableTuiAgent
} from '../../../../../../shared/agent-session-resume'
import { isStructuredWorkerHandle } from '../../../../../../shared/structured-worker-handle'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  carryWorkerResumeSession,
  readWorkerResumeSession,
  resolveWorkerLineage,
  type WorkerResumeSession
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { DispatchContextRow, MessageType } from '../../../../orchestration/types'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { resolveStructuredWorkerIdentity } from '../../../../structured-worker-authority'
import type { RpcContext } from '../../../core'
import { startWorker } from '../worker/workers'
import { earlierWork, followUpReceipt, parseStartOptions } from './worker-follow-up-receipt'
import {
  reopenWorkerChat,
  reopenWorkerTerminal,
  type WorkerFollowUp
} from '../worker/worker-follow-up-placement'

/** What a coordinator sends a working worker; lifecycle and worker-side types keep their refusal. */
const FOLLOW_UP_TYPES: readonly MessageType[] = ['status', 'dispatch', 'handoff']
const ACTIVE_STATUSES: readonly string[] = ['pending', 'dispatched']
const RELEASE_SETTLE_WAIT_MS = 15_000

export type WorkerFollowUpDelivery = 'follow_up' | 'reopened' | 'started_fresh'

type Placement = {
  delivery: WorkerFollowUpDelivery
  worktreeId: string
  terminal?: string
  agent?: string
  model?: string
  effort?: string
  /** Earlier task and report, for a fresh agent that cannot reopen the conversation. */
  earlierWork?: string
  reopen?: WorkerFollowUp['reopen']
}

export type WorkerFollowUpOutcome =
  | { kind: 'steer'; dispatchId: string }
  | { kind: 'started'; receipt: Record<string, unknown> }

type FollowUpContext = Pick<
  RpcContext,
  'runtime' | 'orchestrationCompatibilityEvidence' | 'orchestrationCaller'
>

/** Undefined when the address names no Dispatch this host runs a worker for; the mail path decides then. */
export async function sendWorkerFollowUp(args: {
  ctx: FollowUpContext
  db: OrchestrationDb
  dispatchId: string
  from: string
  type: MessageType
  subject: string
  body: string | undefined
}): Promise<WorkerFollowUpOutcome | undefined> {
  const { ctx, db } = args
  const addressed = db.getDispatchContextById(args.dispatchId)
  // A working worker reads its mail; only a settled Dispatch can have been continued.
  const lineage =
    addressed && !ACTIVE_STATUSES.includes(addressed.status)
      ? resolveWorkerLineage(db, addressed.id)
      : undefined
  if (!lineage) {
    return undefined
  }
  const { latest, resource } = lineage
  if (ACTIVE_STATUSES.includes(latest.status)) {
    return { kind: 'steer', dispatchId: latest.id }
  }
  // Lifecycle types, paired-server workers and Dispatches no worker-start ran keep the mail path's refusal.
  if (
    !FOLLOW_UP_TYPES.includes(args.type) ||
    db.getFederatedDispatch(latest.id) ||
    !db.getWorkerDispatch(resource?.origin_dispatch_id ?? latest.id)
  ) {
    return latest.id === args.dispatchId ? undefined : { kind: 'steer', dispatchId: latest.id }
  }
  const placement = await chooseWorkerFollowUpPlacement(ctx.runtime, db, latest, resource)
  const spec = [args.body || args.subject, placement.earlierWork].filter(Boolean).join('\n\n')
  let receipt: unknown
  try {
    receipt = await startWorker(
      {
        from: args.from,
        run: latest.run_id,
        spec,
        taskTitle: args.subject,
        worktree: `id:${placement.worktreeId}`,
        ...(placement.terminal ? { terminal: placement.terminal } : {}),
        ...(placement.agent ? { agent: placement.agent } : {}),
        ...(placement.model ? { model: placement.model } : {}),
        ...(placement.effort ? { effort: placement.effort } : {})
      },
      ctx,
      { of: latest.id, ...(placement.reopen ? { reopen: placement.reopen } : {}) }
    )
  } catch (error) {
    // A racing send claimed this worker first; this message steers that follow-up.
    if (error instanceof OrchestrationError && error.code === 'follow_up_claimed') {
      return { kind: 'steer', dispatchId: readClaimedDispatchId(error) ?? latest.id }
    }
    throw error
  }
  const started = followUpReceipt(placement.delivery, latest.id, receipt)
  if (resource && typeof started.dispatchId === 'string' && placement.reopen) {
    carryWorkerResumeSession(db, started.dispatchId, resource)
  }
  return { kind: 'started', receipt: started }
}

/** Effect-free: which of open, reopened or fresh applies, refusing what no placement can take. */
async function chooseWorkerFollowUpPlacement(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  latest: DispatchContextRow,
  found: WorkerTerminalResourceRow | undefined
): Promise<Placement> {
  const worker = db.getWorkerDispatch(found?.origin_dispatch_id ?? latest.id)
  const worktreeId = found?.worktree_id ?? worker?.worktree_id
  if (!worker || !worktreeId) {
    throw notRestartable(latest.id)
  }
  const workspace = await runtime.showManagedTerminalWorkspace(`id:${worktreeId}`).catch(() => null)
  if (!workspace) {
    throw new OrchestrationError(
      'worker_workspace_gone',
      `The workspace Dispatch ${latest.id}'s worker ran in was removed; start a new worker with worker-start. No effects were applied.`,
      { effectsApplied: false }
    )
  }
  const options = parseStartOptions(worker.start_options)
  const resource = found && (await settledRelease(db, found))
  if (resource && isStructuredWorkerHandle(resource.terminal_handle)) {
    const handle = resource.terminal_handle
    return chatTabOpen(db, resource)
      ? { delivery: 'follow_up', worktreeId, terminal: handle }
      : {
          delivery: 'reopened',
          worktreeId,
          ...(options.agent ? { agent: options.agent } : {}),
          reopen: () => reopenWorkerChat(runtime, db, handle)
        }
  }
  if (resource && (await terminalWorkerOpen(runtime, resource))) {
    return { delivery: 'follow_up', worktreeId, terminal: resource.terminal_handle }
  }
  const session = readWorkerResumeSession(resource)
  if (session && isResumableTuiAgent(session.agent)) {
    const userTab = await userTabHoldingSession(runtime, session)
    return userTab
      ? { delivery: 'follow_up', worktreeId, terminal: userTab }
      : {
          delivery: 'reopened',
          worktreeId,
          agent: session.agent,
          reopen: (dispatchId) => reopenWorkerTerminal(runtime, worktreeId, session, dispatchId)
        }
  }
  if (!options.agent) {
    throw notRestartable(latest.id)
  }
  return {
    delivery: 'started_fresh',
    worktreeId,
    agent: options.agent,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    earlierWork: earlierWork(db, latest)
  }
}

/** A close in progress is final; wait it out so the worker is reopened rather than fought over. */
async function settledRelease(
  db: OrchestrationDb,
  resource: WorkerTerminalResourceRow
): Promise<WorkerTerminalResourceRow> {
  const deadline = Date.now() + RELEASE_SETTLE_WAIT_MS
  let current = resource
  while (['requested', 'releasing'].includes(current.release_state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    current = db.getWorkerTerminalResource(resource.id) ?? current
  }
  return current
}

function released(resource: WorkerTerminalResourceRow): boolean {
  return resource.ownership_state === 'released' || resource.release_state === 'released'
}

function chatTabOpen(db: OrchestrationDb, resource: WorkerTerminalResourceRow): boolean {
  const identity = resolveStructuredWorkerIdentity(resource.terminal_handle, db)
  const host = getStructuredAgentSessionHost()
  return !released(resource) && !!identity && !!host?.isSessionTabVisible(identity.sessionId)
}

async function terminalWorkerOpen(
  runtime: OrcaRuntimeService,
  resource: WorkerTerminalResourceRow
): Promise<boolean> {
  const handle = resource.terminal_handle
  const paneKey = runtime.getLiveTerminalPaneKey(handle)
  return (
    !released(resource) &&
    !!paneKey &&
    !!resource.pane_key &&
    isEquivalentPaneKey(resource.pane_key, paneKey) &&
    runtime.getTerminalProcessIncarnation(handle) === resource.process_incarnation &&
    (await runtime.isTerminalRunningAgent(handle))
  )
}

/** The user resumed the conversation in a tab of their own: the follow-up goes there and the tab stays theirs. */
async function userTabHoldingSession(
  runtime: OrcaRuntimeService,
  session: WorkerResumeSession
): Promise<string | undefined> {
  for (const row of runtime.getAgentStatusSnapshotFn?.() ?? []) {
    const handle =
      row.agentType === session.agent &&
      !row.structuredHost &&
      agentProviderSessionsEqual(session.agent, row.providerSession, session.providerSession)
        ? runtime.getTerminalHandleForPaneKey(row.paneKey)
        : null
    if (handle && (await runtime.isTerminalRunningAgent(handle))) {
      return handle
    }
  }
  return undefined
}

function notRestartable(dispatchId: string): OrchestrationError {
  return new OrchestrationError(
    'worker_not_restartable',
    `Dispatch ${dispatchId} has no worker Orca started that it can continue; start a new worker with worker-start. No effects were applied.`,
    { effectsApplied: false }
  )
}

function readClaimedDispatchId(error: OrchestrationError): string | undefined {
  const data = error.data
  const id =
    typeof data === 'object' && data !== null && 'followUpDispatchId' in data
      ? data.followUpDispatchId
      : undefined
  return typeof id === 'string' ? id : undefined
}
