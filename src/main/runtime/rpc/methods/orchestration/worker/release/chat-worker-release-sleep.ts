import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../../shared/execution-host/execution-host'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { workerEffectsCreatedWorktree } from '../../../../../orchestration/db/worker-dispatch/worker-created-worktrees'
import type { WorkerTerminalReleaseRuntime } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import type { WorkerTerminalResourceRow } from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import { requireRunningStructuredWorker } from '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import type { StructuredWorkerIdentity } from '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { botOfSession } from '../../../../../../bots/bot-session-tabs'
import { startedForBot } from '../start/worker-keep-open-default'
import { getStructuredAgentSessionHost } from '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionCloseWork } from '../../../../../../native-chat/agent-session-wire/termination/structured-agent-session-close-work'
import type { WorkspaceChatStopAdmission } from '../../../../../../native-chat/agent-session-wire/termination/structured-agent-session-workspace-sleep'

/** The dispatches one worker ran: this one and every earlier one it followed up. */
function followUpLineage(db: OrchestrationDb, dispatchId: string): Set<string> {
  const lineage = new Set<string>()
  for (
    let id: string | null | undefined = dispatchId;
    id && !lineage.has(id);
    id = db.getDispatchContextById(id)?.follow_up_of_dispatch_id
  ) {
    lineage.add(id)
  }
  return lineage
}

/** Whether this worker made the workspace and no other worker ever ran in it; Sleep acts on the whole workspace. */
export function workspaceMadeForWorker(
  db: OrchestrationDb,
  dispatchId: string,
  worktreeId: string
): boolean {
  const lineage = followUpLineage(db, dispatchId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects exactly these columns.
  const uses = db.db
    .prepare(
      `SELECT dispatch_id, effects FROM worker_dispatches
        WHERE COALESCE(worktree_id, CASE WHEN json_valid(start_options)
          THEN json_extract(start_options, '$.resolvedWorktreeId') END) = ?
       UNION ALL
       SELECT dispatch_id, effects FROM remote_dispatch_attachments WHERE worktree_id = ?`
    )
    .all(worktreeId, worktreeId) as { dispatch_id: string; effects: string }[]
  return (
    uses.every((use) => lineage.has(use.dispatch_id)) &&
    uses.some((use) => workerEffectsCreatedWorktree(use.effects, worktreeId))
  )
}

/** `refused`: an automatic release met a turn in the chat's session lane. `unproven`: it was
 *  admitted there but Sleep did not prove the stop. `not_applicable`: nothing was judged; close instead. */
export type ChatWorkerReleaseSleep = 'slept' | 'refused' | 'unproven' | 'not_applicable'

/** Whether the workspace holds nothing but this worker's chat: Sleep stops and hides everything in it. */
async function workspaceHoldsOnlyWorkerChat(
  runtime: Pick<WorkerTerminalReleaseRuntime, 'listMobileSessionTabs'>,
  worktreeId: string,
  workerSessionIds: ReadonlySet<string>
): Promise<boolean> {
  const host = getStructuredAgentSessionHost()
  if (!host || !runtime.listMobileSessionTabs) {
    return false
  }
  const otherChat = host.deps.store
    .listConversations()
    .some(
      (record) =>
        record.location.workspaceId === worktreeId && !workerSessionIds.has(record.sessionId)
    )
  if (otherChat) {
    return false
  }
  const { tabs } = await runtime.listMobileSessionTabs(`id:${worktreeId}`, undefined, {
    includeAgentSenders: false
  })
  return tabs.every((tab) => tab.type === 'agent-session' && workerSessionIds.has(tab.sessionId))
}

/** A bot's chat worker in a workspace made for it, and holding nothing else, is released by
 *  sleeping that workspace: its chat stays with its conversation, and the next message wakes it. */
export async function sleepChatWorkerForRelease(args: {
  runtime: WorkerTerminalReleaseRuntime
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  structured: StructuredWorkerIdentity
  /** An automatic release's admission, judged where Sleep stops the chat. */
  admitClose?: (work: StructuredAgentSessionCloseWork) => boolean
}): Promise<ChatWorkerReleaseSleep> {
  const { runtime, db, dispatchId, resource, structured, admitClose } = args
  const worktreeId = resource.worktree_id ?? structured.worktreeId
  const { bots, sleepWorkspaces } = runtime
  if (
    !worktreeId ||
    !bots ||
    !sleepWorkspaces ||
    !startedForBot(db, dispatchId, (id) => botOfSession(bots, id) !== null) ||
    !workspaceMadeForWorker(db, dispatchId, worktreeId)
  ) {
    return 'not_applicable'
  }
  let sessionId: string
  let lineage: readonly string[]
  try {
    ;({ sessionId, lineage } = requireRunningStructuredWorker(structured))
  } catch {
    return 'not_applicable'
  }
  if (!(await workspaceHoldsOnlyWorkerChat(runtime, worktreeId, new Set(lineage)))) {
    return 'not_applicable'
  }
  let refused = false
  let admitted = false
  // Another chat in the lineage may rest; one that is working refuses the release like the worker's own.
  const admit: WorkspaceChatStopAdmission | undefined =
    admitClose &&
    ((id, work) => {
      if (id !== sessionId && work.state === 'idle') {
        return true
      }
      const ok = admitClose(work)
      refused ||= !ok
      admitted ||= ok && id === sessionId
      return ok
    })
  const self = { kind: 'self' } as const
  const [outcome] = await sleepWorkspaces.call(
    runtime,
    { targets: [{ worktreeId, terminalHost: self, chatHosts: [self] }], markChatsAsleep: true },
    admit
  )
  if (refused) {
    return 'refused'
  }
  const stopped = outcome?.receipts.some(
    (receipt) =>
      receipt.executionHostId === LOCAL_EXECUTION_HOST_ID &&
      receipt.stoppedSessionIds.includes(sessionId)
  )
  if (stopped) {
    return 'slept'
  }
  return admitted ? 'unproven' : 'not_applicable'
}
