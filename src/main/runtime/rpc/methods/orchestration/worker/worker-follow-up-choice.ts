/** Which placement a follow-up takes: in place while the worker's agent still runs, reopened in its saved
 *  conversation once closed, or a fresh agent of the same kind. Effect-free except closing a pane Orca owns
 *  whose agent is proven gone, so the replacement never sits beside it. */

import {
  agentProviderSessionsEqual,
  isResumableTuiAgent
} from '../../../../../../shared/agent-session-resume'
import { isStructuredWorkerHandle } from '../../../../../../shared/structured-worker-handle'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  readWorkerResumeSession,
  type WorkerResumeSession
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { DispatchContextRow } from '../../../../orchestration/types'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { resolveStructuredWorkerIdentity } from '../../../../structured-worker-authority'
import { earlierWork, parseStartOptions } from './worker-earlier-work'
import {
  reopenWorkerChat,
  reopenWorkerTerminal,
  type WorkerFollowUp
} from './worker-follow-up-placement'
import { inspectWorkerTerminal } from './worker-observation'
import { completeWorkerTerminalRelease } from './worker-release-completion'

const RELEASE_SETTLE_WAIT_MS = 15_000

export type WorkerFollowUpDelivery = 'follow_up' | 'reopened' | 'started_fresh'

/** Around the durable close of a leftover shell: the start owner's last admission check, then word that the close was requested. */
export type LeftoverShellRelease = { admit: () => void; requested: (dispatchId: string) => void }

export type WorkerFollowUpPlacement = {
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

export async function chooseWorkerFollowUpPlacement(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  latest: DispatchContextRow,
  found: WorkerTerminalResourceRow | undefined,
  release: LeftoverShellRelease
): Promise<WorkerFollowUpPlacement> {
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
  const open =
    resource && !released(resource)
      ? await openWorkerTerminal(runtime, db, resource, release)
      : null
  if (open) {
    return { delivery: 'follow_up', worktreeId, terminal: open }
  }
  // Read after any close above, which saves the conversation the pane last reported.
  const session = readWorkerResumeSession(resource && db.getWorkerTerminalResource(resource.id))
  if (session && isResumableTuiAgent(session.agent)) {
    const userTab = await userTabHoldingSession(runtime, session)
    return userTab
      ? { delivery: 'follow_up', worktreeId, terminal: userTab }
      : {
          delivery: 'reopened',
          worktreeId,
          agent: session.agent,
          earlierWork: earlierWork(db, latest),
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

/** The handle a follow-up takes in place, or null once its agent is proven gone; never a guess. */
async function openWorkerTerminal(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  resource: WorkerTerminalResourceRow,
  release: LeftoverShellRelease
): Promise<string | null> {
  const inspected = await inspectWorkerTerminal(runtime, db, resource.owner_dispatch_id)
  if (inspected.status === 'unverifiable') {
    throw unverifiable(resource.owner_dispatch_id, inspected.reason ?? 'unknown')
  }
  // A changed or unread identity proves nothing about the recorded process either.
  if (['missing', 'unattached', 'identity_changed'].includes(inspected.status)) {
    // Before a restart restores its terminals, a worker that still runs has no handle yet.
    const process = resource.process_incarnation
      ? await runtime.inspectTerminalProcessIncarnationLiveness(
          resource.process_incarnation,
          resource.host_scope
        )
      : 'unverifiable'
    if (process !== 'exited') {
      throw unverifiable(resource.owner_dispatch_id, `its process is ${process}`)
    }
    return null
  }
  const live = inspected.status === 'live' ? inspected.terminalHandle : null
  if (live && (await runtime.isTerminalRunningAgent(live))) {
    return live
  }
  if ((live || inspected.status === 'exited') && resource.ownership_state === 'owned') {
    await releaseLeftoverShell(runtime, db, resource.owner_dispatch_id, release)
  }
  return null
}

/** The agent exited and left Orca's shell behind: close it the way worker-release does before replacing it. */
async function releaseLeftoverShell(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  release: LeftoverShellRelease
): Promise<void> {
  release.admit()
  const requested = db.requestWorkerTerminalRelease(dispatchId)
  if (requested.disposition === 'requested') {
    release.requested(dispatchId)
    await completeWorkerTerminalRelease({ runtime, db, dispatchId, resource: requested.resource })
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

function unverifiable(dispatchId: string, reason: string): OrchestrationError {
  return new OrchestrationError(
    'worker_unverifiable',
    `Orca cannot tell whether Dispatch ${dispatchId}'s worker still runs (${reason}), so it starts no second one. Send again once worker-show reads it. No effects were applied.`,
    { effectsApplied: false }
  )
}

function notRestartable(dispatchId: string): OrchestrationError {
  return new OrchestrationError(
    'worker_not_restartable',
    `Dispatch ${dispatchId} has no worker Orca started that it can continue; start a new worker with worker-start. No effects were applied.`,
    { effectsApplied: false }
  )
}
