import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { runtimePathsEqual } from '../workspaces/catalog/runtime-worktree-path-identity'
import { chatWorkspaceNameUpdate } from './chat-workspace-name'

export async function nameChatWorkspaceFromSession(
  store: Pick<RuntimeStore, 'getRepos' | 'updateRepo'>,
  resolveWorkspace: (id: string) => Promise<{ path: string; executionHostId: ExecutionHostId }>,
  record: AgentSessionRecord
): Promise<string | null> {
  if (!store.getRepos().some((repo) => repo.chatWorkspace?.autoName)) {
    return null
  }
  const workspace = await resolveWorkspace(record.location.workspaceId)
  if (workspace.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const repo = store
    .getRepos()
    .find(
      (candidate) =>
        candidate.chatWorkspace &&
        getRepoExecutionHostId(candidate) === LOCAL_EXECUTION_HOST_ID &&
        runtimePathsEqual(candidate.path, workspace.path)
    )
  const host = getStructuredAgentSessionHost()
  if (!repo || !host) {
    return null
  }
  const candidates = host.deps.store
    .listRecords()
    .filter(
      (session) =>
        !session.forkedFrom &&
        session.location.workspaceId === record.location.workspaceId &&
        session.location.executionHostId === record.location.executionHostId &&
        session.location.wslDistro === record.location.wslDistro
    )
  const prompts = await Promise.all(
    candidates.map(async (session) => ({
      sessionId: session.sessionId,
      first: await host.deps.store.firstSubmittedUserPrompt(session.sessionId, 0)
    }))
  )
  if (prompts.some(({ first }) => first.kind === 'incomplete')) {
    return null
  }
  const latest = store
    .getRepos()
    .find(
      (candidate) =>
        candidate.id === repo.id &&
        candidate.path === repo.path &&
        getRepoExecutionHostId(candidate) === LOCAL_EXECUTION_HOST_ID
    )
  const update = latest
    ? chatWorkspaceNameUpdate(
        latest,
        record,
        prompts.flatMap(({ sessionId, first }) =>
          first.kind === 'found' ? [{ sessionId, submittedAt: first.submittedAt }] : []
        )
      )
    : null
  return update && store.updateRepo(repo, update) ? repo.id : null
}
