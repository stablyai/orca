import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrchestrationParty } from '../../../../orchestration/orchestration-party'
import { CHAT_WORKER_AUTHORITY } from '../chat-assignee-admission'
import type { WorkerResumeSession } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  resolveStructuredWorkerIdentity,
  structuredWorkerSession
} from '../../../../structured-worker-authority'

/** What a follow-up continues, and for a closed worker how it comes back once the follow-up holds its Dispatch. */
export type WorkerFollowUp = {
  /** The settled Dispatch whose worker this one continues. */
  of: string
  /** Resolves null when the agent refused to resume before spawning anything; a fresh one starts instead. */
  reopen?: (dispatchId: string) => Promise<ReopenedWorker | null>
  /** The send this follow-up answers, whose pending receipt names the Dispatch it accepted. */
  acceptedBy?: { callerFingerprint: string; requestId: string }
  /** Unread mail this follow-up carries as its Task. */
  consumesMessageIds?: readonly string[]
  /** Appended to the Task when a reopen falls back to a fresh agent. */
  earlierWork?: string
}

/** `userOpened`: the user's own tab, which stays theirs and is never closed by Orca. */
export type ReopenedWorker = {
  handle: string
  chat: boolean
  userOpened: boolean
  /** A reopened chat's custody identity; a resumed terminal's comes from its new pane. */
  authority?: { paneKey: string; processIncarnation: string; hostScope: string }
}

/** Resume a closed terminal worker's conversation in a new background tab; never a shell. Null: start a fresh agent. */
export async function reopenWorkerTerminal(
  runtime: Pick<OrcaRuntimeService, 'resumeAgentSessionInWorkspace'>,
  worktreeId: string,
  session: WorkerResumeSession,
  dispatchId: string
): Promise<ReopenedWorker | null> {
  const resumed = await runtime.resumeAgentSessionInWorkspace(worktreeId, {
    ...session,
    // A retry of this follow-up reconciles the pane it may have started.
    mutationId: dispatchId
  })
  if (resumed.ok) {
    return { handle: resumed.handle, chat: false, userOpened: false }
  }
  switch (resumed.reason) {
    case 'window_owns_wake':
      throw new OrchestrationError(
        'worker_asleep',
        "The worker's workspace is asleep in a window; wake it and send again."
      )
    case 'windows_only_cli':
      throw new OrchestrationError('worker_agent_unavailable', resumed.message)
    case 'held_elsewhere':
      throw new OrchestrationError(
        'worker_unreachable',
        "The worker's conversation is open somewhere Orca cannot reach; nothing was sent."
      )
    case 'no_resume_command':
      // Refused before anything spawned, so a fresh agent cannot duplicate it.
      return null
    case 'aborted':
    case 'create_failed':
      throw new OrchestrationError(
        'worker_reopen_failed',
        `Orca could not reopen the worker's ${session.agent} conversation (${resumed.reason}).`
      )
  }
}

/** A reopened chat is a chat too; a tab the user reopened stays theirs, as a `--terminal` does.
 *  `created`: a pane this start made, whose custody it records at once. */
export function placedWorkerParty(
  placed: { reopened?: ReopenedWorker },
  chat: unknown,
  terminal: OrchestrationParty | '' | undefined
): {
  workerChat: boolean
  external: boolean
  created: boolean
  authority: ReopenedWorker['authority'] | typeof CHAT_WORKER_AUTHORITY | undefined
} {
  const workerChat = chat !== null || placed.reopened?.chat === true
  const external = Boolean(terminal) || placed.reopened?.userOpened === true
  // A structured worker's chat keeps the pane and process its custody is held under.
  const chatAuthority =
    terminal && terminal.terminalHandle === null ? CHAT_WORKER_AUTHORITY : undefined
  return {
    workerChat,
    external,
    created: !workerChat && !external,
    authority: placed.reopened?.authority ?? chatAuthority
  }
}

/** Bring a closed worker's chat back as a background tab in its own conversation; its next turn starts the agent at rest.
 *  Its custody identity comes from the worker, since its released row cannot vouch for it. */
export async function reopenWorkerChat(
  runtime: Pick<
    OrcaRuntimeService,
    'ensureStructuredAgentSessionHost' | 'publishStructuredAgentSessionTab'
  >,
  db: OrchestrationDb,
  handle: string
): Promise<ReopenedWorker> {
  const identity = resolveStructuredWorkerIdentity(handle, db)
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!identity || !host) {
    throw new OrchestrationError(
      'worker_not_restartable',
      `Worker ${handle} has no chat Orca can reopen; start a new worker with worker-start.`
    )
  }
  // A `/clear` moved the conversation on; reopen the session that runs it now.
  const running = structuredWorkerSession(identity)
  const sessionId = running.kind === 'here' ? running.sessionId : identity.sessionId
  const userOpened = host.isSessionTabVisible(sessionId)
  const revealed = await host.revealSession(sessionId)
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: revealed.workspaceId,
    sessionId: revealed.sessionId,
    agent: revealed.agent,
    activate: false
  })
  return {
    handle,
    chat: true,
    userOpened,
    authority: {
      paneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation,
      hostScope: JSON.stringify(identity.hostScope)
    }
  }
}
