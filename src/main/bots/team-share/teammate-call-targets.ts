// What a workspace teammate's call names, and whether each is the shared agent's: a workspace, repo,
// GitHub repo, chat, agent CLI session, terminal, pane, browser page, orchestration party or stored
// attachment. A `scoped` call must name at least one and every one must be the agent's; one it
// can't resolve is refused, never taken as the owner's whole host.
import type { RpcContext } from '../../runtime/rpc/core'
import type { RpcMethodShare } from '../../../shared/bots/bot-share-rpc-methods'
import { isPublicOrchestrationAddress } from '../../../shared/orchestration/mailbox/orchestration-agent-reference'
import {
  agentHasGitHubSlug,
  agentHasRepoSelector,
  agentHasWorkspace,
  agentHasWorkspaceSelector,
  type AgentWorkspaceSet
} from '../../runtime/workspaces/process-listing/agent-workspace-set'
import { getAgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { locateParty } from '../../runtime/rpc/methods/orchestration/caller-show'
import { chatWorkspaceOf } from './teammate-client-events'
import { readTeammateWorkspaceSet, workspaceTeammateOf } from './agent-workspace-tracker'

export type TeammateCallTarget =
  | { kind: 'workspace' | 'repo' | 'chat' | 'agent-cli-session' | 'terminal' | 'pane'; id: string }
  | { kind: 'new-chat'; id: string }
  | { kind: 'github'; owner: string; repo: string }
  | { kind: 'page'; id: string; workspace: string | undefined }
  | { kind: 'party'; id: string }
  | { kind: 'attachment'; path: string | undefined }

/** The params a target is read from (`teammateCallTargets`), for the census test. */
export const TEAMMATE_TARGET_PARAMS: ReadonlySet<string> = new Set([
  'worktree',
  'worktreeId',
  'workspaceId',
  'location',
  'target',
  'repo',
  'repoId',
  'sessionId',
  'sessionIds',
  'envelope',
  'terminal',
  'paneKey',
  'pane',
  'party',
  'address',
  'from',
  'path'
])

/** Scoped methods that read only host facts (which agents and tools it has), naming no workspace. */
export const TEAMMATE_HOST_FACT_METHODS: ReadonlySet<string> = new Set([
  'agentSession.agents',
  'repo.gitAvailable'
])

/** Methods whose envelope mints a new chat's id: it is the agent's when its workspace is. */
const NEW_CHAT_METHODS: ReadonlySet<string> = new Set([
  'agentSession.create',
  'agentSession.ensure'
])

type Row = Record<string, unknown>
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null
const rowOf = (value: unknown): Row => (isRow(value) ? value : {})
const strings = (values: readonly unknown[]): string[] =>
  values.flatMap((value) => (typeof value === 'string' ? [value] : []))

export function teammateCallTargets(
  methodName: string,
  share: RpcMethodShare,
  params: unknown
): TeammateCallTarget[] {
  const p = rowOf(params)
  const location = rowOf(p.location)
  const envelope = rowOf(p.envelope)
  const target = rowOf(p.target)
  const create = rowOf(target.create)
  const workspaces = strings([
    p.worktree,
    p.worktreeId,
    p.workspaceId,
    location.workspaceId,
    target.worktree
  ])
  const targets: TeammateCallTarget[] = []
  if (methodName.startsWith('browser.') && typeof p.page === 'string') {
    // A page is the agent's when the agent's workspace it is named with shows it.
    targets.push({ kind: 'page', id: p.page, workspace: workspaces[0] })
  }
  targets.push(...workspaces.map((id) => ({ kind: 'workspace' as const, id })))
  if (methodName.endsWith('BySlug') && typeof p.owner === 'string' && typeof p.repo === 'string') {
    targets.push({ kind: 'github', owner: p.owner, repo: p.repo })
  } else {
    const repos = [p.repo, p.repoId, create.repo].map((repo) =>
      isRow(repo) ? repo.selector : repo
    )
    targets.push(...strings(repos).map((id) => ({ kind: 'repo' as const, id })))
  }
  const chats = strings([p.sessionId, ...(Array.isArray(p.sessionIds) ? p.sessionIds : [])])
  const chatKind = methodName.startsWith('nativeChat.') ? 'agent-cli-session' : 'chat'
  targets.push(...chats.map((id) => ({ kind: chatKind, id }) as const))
  if (typeof envelope.sessionId === 'string') {
    const kind = NEW_CHAT_METHODS.has(methodName) ? 'new-chat' : 'chat'
    targets.push({ kind, id: envelope.sessionId })
  }
  targets.push(...strings([p.terminal]).map((id) => ({ kind: 'terminal' as const, id })))
  targets.push(...strings([p.paneKey, p.pane]).map((id) => ({ kind: 'pane' as const, id })))
  const parties = strings([p.party, p.address, p.from]).filter(isPublicOrchestrationAddress)
  targets.push(...parties.map((id) => ({ kind: 'party' as const, id })))
  if (share !== 'not-shared' && share.kind === 'attachment') {
    targets.push({ kind: 'attachment', path: typeof p.path === 'string' ? p.path : undefined })
  }
  return targets
}

export async function teammateTargetIsAgents(
  context: RpcContext,
  set: AgentWorkspaceSet,
  target: TeammateCallTarget
): Promise<boolean> {
  const { runtime } = context
  switch (target.kind) {
    case 'workspace':
      return agentHasWorkspaceSelector(set, target.id)
    case 'repo':
      return agentHasRepoSelector(set, target.id)
    case 'github':
      return agentHasGitHubSlug(set, target.owner, target.repo)
    case 'chat':
      return agentHasWorkspace(set, chatWorkspaceOf(target.id))
    case 'new-chat': {
      // An id already in use must be one of the agent's chats; a new one takes its named workspace.
      const existing = chatWorkspaceOf(target.id)
      return existing === undefined || agentHasWorkspace(set, existing)
    }
    case 'agent-cli-session':
      return runtime
        .getAgentProviderSessionRows()
        .some(
          (row) =>
            row.providerSession?.id === target.id &&
            agentHasWorkspace(
              set,
              row.worktreeId ?? runtime.getTerminalWorktreeIdForPaneKey(row.paneKey)
            )
        )
    case 'terminal':
      return agentHasWorkspace(set, runtime.getTerminalWorktreeIdForHandle(target.id))
    case 'pane':
      return agentHasWorkspace(set, runtime.getTerminalWorktreeIdForPaneKey(target.id))
    case 'page':
      return (
        target.workspace !== undefined &&
        agentHasWorkspaceSelector(set, target.workspace) &&
        (await runtime.browserTabList({ worktree: target.workspace })).tabs.some(
          (tab) => tab.browserPageId === target.id
        )
      )
    case 'party':
      return partyIsAgents(context, set, target.id)
    case 'attachment':
      return attachmentIsAgents(context, set, target.path)
  }
}

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
  context: RpcContext,
  set: AgentWorkspaceSet,
  path: string | undefined
): Promise<boolean> {
  await context.runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const claimed = path
    ? ((await getAgentSessionAttachmentStore()?.claimingSessions(path)) ?? [])
    : []
  return claimed.some((sessionId) => agentHasWorkspace(set, chatWorkspaceOf(sessionId)))
}

/** For a workspace teammate's terminal stream: whether a handle it subscribes is the agent's,
 *  judged against the set as it is then. Undefined for anyone else. */
export function teammateTerminalAdmission(
  context: RpcContext
): ((handle: string) => Promise<boolean>) | undefined {
  const scope = workspaceTeammateOf(context)
  return scope
    ? async (handle) =>
        agentHasWorkspace(
          await readTeammateWorkspaceSet(context.runtime, scope),
          context.runtime.getTerminalWorktreeIdForHandle(handle)
        )
    : undefined
}
