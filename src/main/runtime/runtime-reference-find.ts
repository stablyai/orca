import type {
  ReferenceWorkspace,
  RuntimeReferenceAgent,
  RuntimeReferenceFindParams,
  RuntimeReferenceFindResult
} from '../../shared/runtime-reference-contracts'
import {
  getWorkspaceReferenceIdentity,
  matchesWorkspaceReferenceQuery,
  parseWorkspaceReferenceQuery
} from '../../shared/workspace-reference-identity'
import { getWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
import type { WorkspaceAttachmentOrigin } from '../../shared/worktree/types'
import type { ExecutionHostId } from '../../shared/execution-host'

export type ReferenceAgentCandidate = Omit<RuntimeReferenceAgent, 'linked'> & {
  hostId: ExecutionHostId
  sessionIds?: readonly string[]
}

export type ReferenceAgentIndex = ReadonlyMap<string, readonly ReferenceAgentCandidate[]>

function originMatchesAgent(
  origin: WorkspaceAttachmentOrigin,
  agent: ReferenceAgentCandidate
): boolean {
  if (origin.hostId !== agent.hostId || (origin.agent && origin.agent !== agent.agent)) {
    return false
  }
  // Why: pane keys are reused by later agents in the same pane, so only a session id proves the link.
  return Boolean(origin.sessionId && agent.sessionIds?.includes(origin.sessionId))
}

export async function findWorkspaceReferences(
  params: RuntimeReferenceFindParams,
  source: {
    workspaces: readonly Pick<
      ReferenceWorkspace,
      'id' | 'hostId' | 'name' | 'repo' | 'kind' | 'isArchived' | 'linkedItems'
    >[]
    agents: (
      workspaceKeys: ReadonlySet<string>
    ) => ReferenceAgentIndex | Promise<ReferenceAgentIndex>
  }
): Promise<RuntimeReferenceFindResult> {
  if (params.worktree && params.repo) {
    throw new Error('Use either --worktree or --repo, not both.')
  }
  const limit = params.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Reference limit must be a positive integer.')
  }
  const query = parseWorkspaceReferenceQuery(params.query)
  const matches: RuntimeReferenceFindResult['matches'] = []
  let workspaceCount = 0
  let truncated = false
  const workspaceKeys = new Set<string>()
  for (const workspace of source.workspaces) {
    // Why: an explicitly named workspace is wanted even when archived.
    if (workspace.isArchived && !params.includeArchived && !params.worktree) {
      continue
    }
    const references = (workspace.linkedItems ?? []).filter((item) =>
      matchesWorkspaceReferenceQuery(item, query)
    )
    if (!references.length) {
      continue
    }
    if (workspaceCount === limit) {
      truncated = true
      break
    }
    workspaceCount += 1
    workspaceKeys.add(getWorktreeHostIdentity(workspace))
    for (const reference of references) {
      matches.push({
        reference: { ...reference, key: getWorkspaceReferenceIdentity(reference) },
        workspace: {
          id: workspace.id,
          name: workspace.name,
          repo: workspace.repo,
          kind: workspace.kind,
          archived: workspace.isArchived,
          ...(workspace.hostId ? { hostId: workspace.hostId } : {})
        },
        agents: []
      })
    }
  }
  if (matches.length) {
    const agents = await source.agents(workspaceKeys)
    for (const match of matches) {
      const candidates = agents.get(getWorktreeHostIdentity(match.workspace)) ?? []
      match.agents = candidates.map((candidate) => {
        const { hostId: _hostId, sessionIds: _sessionIds, ...agent } = candidate
        return {
          ...agent,
          linked:
            match.reference.origins?.some((origin) => originMatchesAgent(origin, candidate)) ??
            false
        }
      })
    }
  }
  return {
    kind: 'reference_matches',
    query: params.query,
    scope: {
      source: 'stored-metadata',
      ...(params.worktree ? { worktree: params.worktree } : {}),
      ...(params.repo ? { repo: params.repo } : {}),
      includeArchived: params.includeArchived === true
    },
    truncated,
    matches
  }
}
