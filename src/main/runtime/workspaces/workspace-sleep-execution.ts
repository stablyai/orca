import type { AgentSessionWorkspaceSleepResult } from '../../../shared/agent-session/agent-session-workspace-sleep'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'
import type {
  WorkspaceChatStopReceipt,
  WorkspaceSleepHost,
  WorkspaceSleepNotice,
  WorkspaceSleepOutcome,
  WorkspaceSleepRequest,
  WorkspaceSleepTarget
} from '../../../shared/workspace-sleep'
import {
  requestRemoteWorktreeSleep,
  type RemoteWorkspaceCall
} from './remote-workspace-terminal-sleep'
import type { LifecycleCommand } from './workspace-lifecycle-command'
import { teardownStops } from '../owned-session-teardown-policy'

export type WorkspaceSleepDeps = {
  /** The window follows: it hides the workspace's browsers and panes before any terminal stops. */
  notify: (notice: WorkspaceSleepNotice) => void
  sleepOwnTerminals: (worktreeId: string) => Promise<RuntimeWorktreeTerminalSleepResult>
  callEnvironment: (environmentId: string) => RemoteWorkspaceCall
  stopOwnChats: (
    worktreeId: string,
    markAsleep: boolean
  ) => Promise<AgentSessionWorkspaceSleepResult>
  suspendVm: ((worktreeId: string) => Promise<void>) | null
  /** The wake records main keeps for this host's workspace, read after its terminals stopped. */
  ownRecords: (worktreeId: string) => SleepingAgentSessionRecord[]
  /** Starts watching for the workspace being reopened; the returned check says whether it was. */
  watchReopen: (worktreeId: string) => () => boolean
}

/** The outcome plus whether the host never confirmed it, which pauses the workspace's queue. */
export type WorkspaceSleepAttempt = WorkspaceSleepOutcome & { unverifiable: boolean }

/** How a batch puts each workspace's sleep in its queue. */
export type WorkspaceSleepQueue = {
  submit: (
    target: WorkspaceSleepTarget,
    command: LifecycleCommand<WorkspaceSleepAttempt>
  ) => Promise<WorkspaceSleepAttempt>
  /** Waits behind a pause: it will not stop its chats while this batch waits to suspend VMs. */
  paused: (target: WorkspaceSleepTarget) => boolean
}

const CHAT_STOP_TIMEOUT_MS = 120_000

// A paired server that answered: a refusal carries its code, the rest name what it observed.
const ANSWERED_ENVIRONMENT_FAILURES = new Set([
  'terminal_worktree_sleep_still_live',
  'terminal_worktree_sleep_invalid_response'
])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasCode(error: unknown): boolean {
  return error instanceof Error && 'code' in error
}

function executionHostOf(host: WorkspaceSleepHost): ExecutionHostId {
  return host.kind === 'self'
    ? LOCAL_EXECUTION_HOST_ID
    : toRuntimeExecutionHostId(host.environmentId)
}

/** Only lost contact is unconfirmed; an answer, even a refusal, is a plain failure. */
function terminalLostContact(host: WorkspaceSleepHost, error: unknown): boolean {
  if (host.kind === 'self') {
    return messageOf(error) === 'terminal_liveness_unavailable'
  }
  return !hasCode(error) && !ANSWERED_ENVIRONMENT_FAILURES.has(messageOf(error))
}

/** The terminal PTY ids the window binds, proven stopped; throws when the host cannot prove it. */
async function sleepTerminals(deps: WorkspaceSleepDeps, target: WorkspaceSleepTarget) {
  const host = target.terminalHost
  if (host.kind === 'environment') {
    const handles = await requestRemoteWorktreeSleep(
      deps.callEnvironment(host.environmentId),
      target.worktreeId
    )
    return handles.map((handle) => toRemoteRuntimePtyId(handle, host.environmentId))
  }
  const result = await deps.sleepOwnTerminals(target.worktreeId)
  if (result.postStopVerified !== true) {
    throw Object.assign(new Error(result.postStopFailure), { stoppedPtyIds: result.stoppedPtyIds })
  }
  return result.stoppedPtyIds
}

/** A paired server's chat stop. An older server refuses the Sleep mark, so it is asked without. */
async function stopEnvironmentChats(
  call: RemoteWorkspaceCall,
  workspaceId: string,
  markAsleep: boolean
): Promise<unknown> {
  if (markAsleep) {
    try {
      return await call(
        'agentSession.sleepWorkspace',
        { workspaceId, markAsleep: true },
        CHAT_STOP_TIMEOUT_MS
      )
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'invalid_argument')) {
        throw error
      }
    }
  }
  return call('agentSession.sleepWorkspace', { workspaceId }, CHAT_STOP_TIMEOUT_MS)
}

function isChatStopResult(value: unknown): value is AgentSessionWorkspaceSleepResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'stoppedSessionIds' in value &&
    Array.isArray(value.stoppedSessionIds)
  )
}

type ChatStops = { receipts: WorkspaceChatStopReceipt[]; failed: boolean; lostContact: boolean }

/** Each host stops only the chats it runs, so every one is asked. Never rejects. */
async function stopChats(
  deps: WorkspaceSleepDeps,
  target: WorkspaceSleepTarget,
  markAsleep: boolean
): Promise<ChatStops> {
  const stops: ChatStops = { receipts: [], failed: false, lostContact: false }
  await Promise.all(
    target.chatHosts.map(async (host) => {
      let result: unknown
      try {
        result =
          host.kind === 'self'
            ? await deps.stopOwnChats(target.worktreeId, markAsleep)
            : await stopEnvironmentChats(
                deps.callEnvironment(host.environmentId),
                target.worktreeId,
                markAsleep
              )
      } catch (error) {
        console.error('[workspace-sleep] native chat stop failed', {
          worktreeId: target.worktreeId,
          error
        })
        stops.failed = true
        // A paired server that never answered leaves the chats unconfirmed.
        stops.lostContact ||= host.kind === 'environment' && !hasCode(error)
        return
      }
      if (!isChatStopResult(result)) {
        stops.failed = true
        return
      }
      stops.failed ||= (result.failures?.length ?? 0) > 0
      stops.receipts.push({
        executionHostId: executionHostOf(host),
        stoppedSessionIds: result.stoppedSessionIds
      })
    })
  )
  return stops
}

/**
 * One workspace's sleep, in order: the window hides it, its terminals stop on their host, every
 * host stops its chats, then (once the whole batch's chats settled) its VM suspends — unless it
 * was reopened meanwhile.
 */
async function sleepWorkspace(
  deps: WorkspaceSleepDeps,
  target: WorkspaceSleepTarget,
  markAsleep: boolean,
  batch: { chatsSettled: () => void; batchChatsSettled: Promise<unknown> },
  projectMovePauseId?: string
): Promise<WorkspaceSleepAttempt> {
  const { worktreeId } = target
  const reopened = deps.watchReopen(worktreeId)
  const move = projectMovePauseId ? { projectMovePauseId } : {}
  deps.notify({ worktreeId, phase: 'started', ...move })
  let failure: string | undefined
  let vmSuspendFailure: string | undefined
  let unverifiable = false
  let stoppedPtyIds: string[] | null = null
  let chats: ChatStops = { receipts: [], failed: false, lostContact: false }
  try {
    try {
      stoppedPtyIds = await sleepTerminals(deps, target)
    } catch (error) {
      failure = messageOf(error)
      unverifiable = terminalLostContact(target.terminalHost, error)
      stoppedPtyIds =
        error instanceof Error && 'stoppedPtyIds' in error && Array.isArray(error.stoppedPtyIds)
          ? error.stoppedPtyIds.filter((id): id is string => typeof id === 'string')
          : null
    }
    if (teardownStops('sleep', 'structured-chat')) {
      chats = await stopChats(deps, target, markAsleep)
    }
  } finally {
    batch.chatsSettled()
  }
  // A VM may carry another workspace's host: the whole batch's chats settle before any suspends.
  if (!failure && deps.suspendVm) {
    await batch.batchChatsSettled
    try {
      // Reopened mid-sleep: it is the user's again, so its VM keeps running.
      if (!reopened()) {
        await deps.suspendVm(worktreeId)
      }
    } catch (error) {
      console.error('[workspace-sleep] host suspension failed', { worktreeId, error })
      vmSuspendFailure = messageOf(error)
    }
  }
  const records = target.terminalHost.kind === 'self' ? deps.ownRecords(worktreeId) : null
  deps.notify({ worktreeId, phase: 'ended', slept: !failure, stoppedPtyIds, records, ...move })
  return {
    worktreeId,
    ...(failure ? { failure } : {}),
    ...(vmSuspendFailure ? { vmSuspendFailure } : {}),
    chatFailed: chats.failed,
    receipts: chats.receipts,
    unverifiable: unverifiable || chats.lostContact
  }
}

/**
 * Sleeps a batch, each workspace as a command in its own queue. A workspace whose command a delete
 * cancelled, the queue refused, or a pause holds back releases the batch's VM wait.
 */
export async function sleepWorkspaces(
  deps: WorkspaceSleepDeps,
  queue: WorkspaceSleepQueue,
  request: WorkspaceSleepRequest
): Promise<WorkspaceSleepOutcome[]> {
  // Why unique: both copies of a twin share one id, and sleeping it sleeps the whole workspace.
  const targets = [
    ...new Map(request.targets.map((target) => [target.worktreeId, target])).values()
  ]
  const releases: (() => void)[] = []
  const settled = targets.map(() => new Promise<void>((resolve) => releases.push(resolve)))
  const batchChatsSettled = Promise.all(settled)
  return Promise.all(
    targets.map(async (target, index) => {
      const chatsSettled = releases[index]
      if (queue.paused(target)) {
        chatsSettled()
      }
      try {
        const { unverifiable: _unverifiable, ...outcome } = await queue.submit(target, {
          kind: 'sleep',
          run: () =>
            sleepWorkspace(
              deps,
              target,
              request.markChatsAsleep === true,
              {
                chatsSettled,
                batchChatsSettled
              },
              request.projectMovePauseId
            ),
          outcome: (attempt) => (attempt.unverifiable ? 'unverifiable' : 'settled')
        })
        return outcome
      } catch (error) {
        chatsSettled()
        return {
          worktreeId: target.worktreeId,
          failure: messageOf(error),
          chatFailed: false,
          receipts: []
        }
      }
    })
  )
}
