import type { BotLinkOpenTarget } from '../../shared/bots/bot-link-open-target'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { InvalidArgumentError } from '../runtime/rpc/core'
import {
  readAgentSessionRecordStore,
  clearedInto
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { resolveStructuredWorkerForDispatch } from '../runtime/rpc/methods/orchestration/structured-workers/orchestration-structured-worker-lifecycle'
import { chatAssigneeSessionId } from '../runtime/orchestration/workers/lifecycle/chat-assignee'
import { readWorkerTerminalHostScope } from '../../shared/orchestration/workers/worker-terminal-host-scope'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'

type AuthorityRuntime = Pick<
  OrcaRuntimeService,
  'bots' | 'getExternalConversationSeam' | 'getOrchestrationDb'
>

/** Run without an await immediately before publishing/selecting the caller's exact chat. */
export function assertBotLinkOpenAuthority(
  runtime: AuthorityRuntime,
  guard: BotLinkOpenTarget,
  actual: { sessionId: string; worktreeId: string }
): void {
  const refuse = () => {
    throw new InvalidArgumentError('bot_link_target_changed')
  }
  if (
    actual.sessionId !== guard.sessionId ||
    actual.worktreeId !== guard.worktreeId ||
    !runtime.bots.list().some((bot) => bot.id === guard.botId)
  ) {
    return refuse()
  }
  const linked = runtime.getExternalConversationSeam()?.linkedChat(guard.conversation, guard.botId)
  const record = readAgentSessionRecordStore()?.getRecord(guard.sessionId)
  if (
    !linked ||
    linked.sessionId !== guard.leadSessionId ||
    !record ||
    clearedInto(record) !== null ||
    record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    record.location.workspaceId !== guard.worktreeId
  ) {
    return refuse()
  }
  if (guard.sessionId === guard.leadSessionId) {
    if (linked.worktreeId !== guard.worktreeId) {
      return refuse()
    }
    return
  }
  if (!guard.workerDispatchId) {
    return refuse()
  }
  const db = runtime.getOrchestrationDb()
  const dispatch = db.getDispatchContextById(guard.workerDispatchId)
  const row = db.listWorkerTerminalResources({ dispatchIds: [guard.workerDispatchId] })[0]
  const scope = readWorkerTerminalHostScope(row?.resource?.host_scope ?? dispatch?.host_scope)
  const structured = resolveStructuredWorkerForDispatch(db, guard.workerDispatchId)
  const workerSessionId =
    structured?.sessionId ?? chatAssigneeSessionId(row?.agentTerminalHandle ?? null)
  if (
    !dispatch ||
    dispatch.creator_orca_session_id !== guard.leadSessionId ||
    !row ||
    !row.agentTerminalHandle ||
    (structured &&
      (!row.resource ||
        row.resource.owner_dispatch_id !== guard.workerDispatchId ||
        row.resource.ownership_state !== 'owned' ||
        row.resource.terminal_handle !== structured.handle)) ||
    (scope.kind !== 'local' && scope.kind !== 'absent') ||
    workerSessionId !== guard.sessionId ||
    (structured && structured.hostScope.kind === 'ssh')
  ) {
    return refuse()
  }
}
