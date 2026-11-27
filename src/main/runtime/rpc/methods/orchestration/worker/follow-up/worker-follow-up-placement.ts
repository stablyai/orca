import { resolveResumeLaunchRecipe } from '../../../../../../../shared/agent-launch/choices/resume-launch-recipe'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../../orchestration/orchestration-error'
import type { OrchestrationPartyIdentity as OrchestrationParty } from '../../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import { CHAT_WORKER_AUTHORITY } from '../../chat-assignee-admission'
import type { WorkerResumeSession } from '../../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { getStructuredAgentSessionHost } from '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  requireRunningStructuredWorker,
  resolveStructuredWorkerIdentity,
  structuredWorkerSession
} from '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import type { WorkerFollowUpPlacement } from './worker-follow-up-choice'
import { publishChatTabInBackground } from '../../../../../session-tabs/chat/background-chat-tab-publication'
import type {
  RetainedWorkerAuthority,
  RetainedWorkerTerminal
} from '../../../../../orchestration/db/worker-terminal/worker-terminal-transfer'
import type { RunningStructuredSession } from '../../../../../orchestration/addressing/session-lineage/structured-session-lineage'

/** What a follow-up continues, and for a closed worker how it comes back once the follow-up holds its Dispatch. */
export type WorkerFollowUp = {
  /** The settled Dispatch whose worker this one continues. */
  of: string
  /** The Dispatch the sender named, which a refusal reports. */
  addressed: string
  /** The Dispatch that last took custody of the worker's agent, whose creator owns it; absent when none ever got one, and the first request's creator owns it. */
  custodian?: string
  /** The start owner admits the caller before resolving placement, which may release an owned shell. */
  place: (assertCreatorCurrent: () => void) => Promise<WorkerFollowUpPlacement>
  /** Resolves null when the agent refused to resume before spawning anything; a fresh one starts instead. */
  reopen?: (dispatchId: string) => Promise<ReopenedWorker | null>
  retainedChat?: RetainedWorkerTerminal
  /** The send this follow-up answers, whose pending receipt names the Dispatch it accepted. */
  acceptedBy?: { callerFingerprint: string; requestId: string }
  /** The Dispatch whose unread mail this follow-up's Task tells it to check. */
  takesMailOf?: string
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
    // Why always a recipe: without its own note the worker resumes unrecorded, never with another pane's.
    launchConfig: resolveResumeLaunchRecipe(
      session.launchConfig,
      session.agent,
      session.providerSession
    ),
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
 *  Its custody identity comes from the worker when its row was released or stays external. */
export async function reopenWorkerChat(
  runtime: Pick<
    OrcaRuntimeService,
    'ensureStructuredAgentSessionHost' | 'publishStructuredAgentSessionTab'
  >,
  db: OrchestrationDb,
  handle: string,
  externalCustody = false
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
  // A chat Orca's release left asleep stays Orca's; an external chat or a tab the user brought back stays theirs.
  const userOpened =
    externalCustody ||
    (host.isSessionTabVisible(sessionId) &&
      host.deps.store.getRecord(sessionId)?.sleptAt === undefined)
  await publishChatTabInBackground(runtime, host, sessionId)
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

/** Recheck the exact chat and its placement just before claiming the follow-up. */
export function prepareRetainedWorkerChat(
  runtime: Pick<OrcaRuntimeService, 'publishStructuredAgentSessionTab'>,
  db: OrchestrationDb,
  selected: RetainedWorkerTerminal,
  worktreeId: string | undefined,
  open: boolean
): {
  authority: RetainedWorkerAuthority
  worktreeId: string
  publish: () => Promise<ReopenedWorker>
  assertStarting: (dispatchId: string) => void
} {
  const host = getStructuredAgentSessionHost()
  const identity = resolveStructuredWorkerIdentity(selected.handle, db)
  if (!host || !identity || !worktreeId) {
    throw new OrchestrationError(
      'worker_not_restartable',
      `Worker ${selected.handle} has no chat Orca can reopen. No effects were applied.`,
      { effectsApplied: false }
    )
  }
  const running = requireRunningStructuredWorker(identity)
  if (
    running.record.location.workspaceId !== worktreeId ||
    workerChatTabVisible(host, running) !== open
  ) {
    throw new OrchestrationError(
      'worker_identity_changed',
      `Worker ${selected.handle} no longer has an ${open ? 'open' : 'available closed'} chat in its workspace. No effects were applied.`,
      { effectsApplied: false }
    )
  }
  return {
    worktreeId,
    authority: {
      ...selected,
      paneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation,
      hostScope: JSON.stringify(identity.hostScope)
    },
    publish: async () => {
      await publishChatTabInBackground(runtime, host, running.sessionId)
      return { handle: selected.handle, chat: true, userOpened: false }
    },
    assertStarting: (dispatchId) => {
      const custody = db.getWorkerTerminalResourceByOwner(dispatchId)
      if (
        db.getWorkerDispatch(dispatchId)?.state !== 'starting' ||
        db.getDispatchContextById(dispatchId)?.status !== 'pending' ||
        custody?.id !== selected.resourceId ||
        custody.ownership_state !== 'owned'
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} no longer holds its starting worker.`
        )
      }
    }
  }
}

export function workerChatTabVisible(
  host: NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>,
  running: RunningStructuredSession
): boolean {
  return running.lineage.some((sessionId) => host.isSessionTabVisible(sessionId))
}
