// A workspace teammate's call, once its method is admitted by teammate-method-classes.json: a `scoped`
// call may name only the agent's workspaces, chats, terminals and parties; a `filtered` call runs with
// its answer kept to them; an `own` call runs as it is. The shared agent's own views (its bot, its
// views, the caller's connection) keep the share guard every teammate has.
import type { RpcContext, RpcMethod, RpcStreamingMethod } from '../../runtime/rpc/core'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { teammateMethodClass } from '../../runtime/rpc/callers/teammate-method-classes'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import {
  admitBotShareCall,
  type BotShareRefusal
} from '../../runtime/rpc/dispatch/bot-share-call-admission'
import {
  agentHasRepoSelector,
  agentHasWorkspace,
  agentHasWorkspaceSelector,
  type AgentWorkspaceSet
} from '../../runtime/workspaces/process-listing/agent-workspace-set'
import { getAgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { locateParty } from '../../runtime/rpc/methods/orchestration/caller-show'
import { chatWorkspaceOf } from './teammate-client-events'
import { readTeammateWorkspaceSet } from './agent-workspace-tracker'
import { withTeammateLists } from './teammate-workspace-lists'

type Admitted = { method: RpcMethod | RpcStreamingMethod; params: unknown }
type Row = Record<string, unknown>
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export async function admitTeammateCall<A extends Admitted>(
  context: RpcContext,
  scope: BotShareCallerScope,
  admitted: A
): Promise<A | { refusal: BotShareRefusal }> {
  const { method, params } = admitted
  // The shared agent itself, its views, and the caller's own connection: as for any teammate.
  if (method.share !== 'not-shared' && ['bot', 'scoped', 'self'].includes(method.share.kind)) {
    const answer = await admitBotShareCall(context.runtime, scope, method.share, params)
    return 'refusal' in answer ? answer : { ...admitted, params: answer.params }
  }
  switch (teammateMethodClass(method.name)) {
    case 'own':
      return admitted
    case 'filtered':
      return { ...admitted, method: withTeammateLists(method) }
    case 'scoped': {
      const set = await readTeammateWorkspaceSet(context.runtime, scope)
      return (await namesOnlyAgentWorkspaces(context, set, method, params))
        ? admitted
        : { refusal: 'path_not_found' }
    }
    case 'refused':
      return { refusal: 'method_not_found' }
  }
}

/** Every workspace, repo, chat, terminal, party or attachment the params name is the agent's. */
async function namesOnlyAgentWorkspaces(
  context: RpcContext,
  set: AgentWorkspaceSet,
  method: RpcMethod | RpcStreamingMethod,
  params: unknown
): Promise<boolean> {
  if (!isRow(params)) {
    return true
  }
  const { runtime } = context
  const location = isRow(params.location) ? params.location : {}
  const envelope = isRow(params.envelope) ? params.envelope : {}
  const workspaces = strings([
    params.worktree,
    params.worktreeId,
    params.workspaceId,
    location.workspaceId
  ])
  const repos = strings(
    [params.repo, params.repoId].map((repo) => (isRow(repo) ? repo.selector : repo))
  )
  const sessions = strings([
    params.sessionId,
    envelope.sessionId,
    ...(Array.isArray(params.sessionIds) ? params.sessionIds : [])
  ])
  const terminals = strings([params.terminal])
  const parties = strings([params.party ?? params.address])
  if (sessions.length > 0) {
    // The chat records live in the chat host, which opens lazily.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
  const named =
    workspaces.every((selector) => agentHasWorkspaceSelector(set, selector)) &&
    repos.every((selector) => agentHasRepoSelector(set, selector)) &&
    sessions.every((sessionId) => agentHasWorkspace(set, chatWorkspaceOf(sessionId))) &&
    terminals.every((handle) =>
      agentHasWorkspace(set, runtime.getTerminalWorktreeIdForHandle(handle))
    )
  if (!named) {
    return false
  }
  for (const party of parties) {
    if (!(await partyIsAgents(context, set, party))) {
      return false
    }
  }
  const attachment = method.share !== 'not-shared' && method.share.kind === 'attachment'
  return !attachment || (await attachmentIsAgents(runtime, set, text(params.path)))
}

const strings = (values: readonly unknown[]): string[] =>
  values.flatMap((value) => (typeof value === 'string' ? [value] : []))

/** A crew or dock is watched by its party: a chat's or terminal's, which must be the agent's. */
async function partyIsAgents(
  context: RpcContext,
  set: AgentWorkspaceSet,
  party: string
): Promise<boolean> {
  const { location } = await locateParty({ address: party }, context)
  const workspace =
    location?.kind === 'chat'
      ? location.worktreeId
      : location?.kind === 'terminal' && !location.environmentId
        ? context.runtime.getTerminalWorktreeIdForHandle(location.handle)
        : null
  return agentHasWorkspace(set, workspace)
}

/** A stored attachment is the agent's when a chat in its workspaces claims it. */
async function attachmentIsAgents(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  set: AgentWorkspaceSet,
  path: string | undefined
): Promise<boolean> {
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const claimed = path
    ? ((await getAgentSessionAttachmentStore()?.claimingSessions(path)) ?? [])
    : []
  return claimed.some((sessionId) => agentHasWorkspace(set, chatWorkspaceOf(sessionId)))
}
