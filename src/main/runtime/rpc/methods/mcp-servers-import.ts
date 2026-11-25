// mcpServers.discover/move/copy: the "In your agents" servers on this host, and bringing one into
// the host list. Only reached through mcpServers.*, which refuses while the switch is off.
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import type { McpServer } from '../../../../shared/mcp-servers/mcp-servers'
import {
  isRepoOnCatalogHost,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import {
  AgentMcpServerImportError,
  copyAgentMcpServer,
  listAgentMcpServers,
  localAgentMcpImportHost,
  moveAgentMcpServer,
  workspaceForPathIn,
  type AddImportedMcpServer,
  type AgentMcpImportHost
} from '../../../mcp-servers/agent-configs/agent-mcp-import'
import { AgentMcpConfigEditError } from '../../../mcp-servers/agent-configs/agent-mcp-config-removal'
import {
  addMcpServer,
  removeMcpServer,
  setMcpServerAgentEnabled,
  setMcpServerWorkspaces
} from '../../../mcp-servers/mcp-host-list'
import { McpServersError } from '../../../mcp-servers/mcp-servers-error'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

export { copyAgentMcpServer, listAgentMcpServers, moveAgentMcpServer }

const isLocal = (executionHostId: string | null | undefined): boolean =>
  executionHostId == null || parseExecutionHostId(executionHostId)?.kind === 'local'

/** This host's repos, their worktrees and folder workspaces: what a Claude project path maps to. */
export async function agentMcpImportHost(runtime: OrcaRuntimeService): Promise<AgentMcpImportHost> {
  const store = runtime.requireStore()
  const repos = store.getRepos().filter(isRepoOnCatalogHost)
  const local = new Set(repos.map((repo) => repo.id))
  const { worktrees } = await runtime.listManagedWorktrees(undefined, Number.MAX_SAFE_INTEGER)
  return localAgentMcpImportHost(
    getAppEnvironment().getPath('userData'),
    workspaceForPathIn({
      repos,
      worktrees: worktrees.filter(
        (worktree) => local.has(worktree.repoId) && isLocal(worktree.hostId)
      ),
      folderWorkspaces: (store.getFolderWorkspaces?.() ?? []).filter(
        (folder) => !folder.connectionId && isLocal(folder.executionHostId)
      )
    })
  )
}

function editFailure(error: AgentMcpConfigEditError): string {
  switch (error.reason) {
    case 'changed':
      return `${error.path} changed after Orca listed it, so the server stays there too. Refresh and move it again.`
    case 'unparseable':
      return `Orca couldn’t read ${error.path}, so the server stays there too.`
    case 'not-editable':
      return `Orca couldn’t take the server out of ${error.path} safely, so it stays there too.`
    case 'locked':
      return `Claude Code was saving ${error.path}, so the server stays there too. Try again in a moment.`
  }
}

type AgentMcpImport = (
  host: AgentMcpImportHost,
  key: string,
  add: AddImportedMcpServer<McpServer>
) => Promise<McpServer>

/** Adds the discovered server to the host list (scoped like its agent copy) by `importer`. */
export async function importAgentMcpServer(
  context: RpcContext,
  key: string,
  importer: AgentMcpImport
): Promise<{ server: McpServer }> {
  let added = false
  const add: AddImportedMcpServer<McpServer> = async (server, { workspaces, agentsOff }) => {
    let saved = await addMcpServer(server, { nameGiven: false, signal: context.signal })
    try {
      if (workspaces) {
        saved = await setMcpServerWorkspaces(saved.id, workspaces)
      }
      for (const agent of agentsOff) {
        saved = await setMcpServerAgentEnabled(saved.id, agent, false)
      }
    } catch (error) {
      // Never leave it on wider than its agent copy was: take the half-made row back out.
      await removeMcpServer(saved.id).catch(() => {})
      throw error
    }
    added = true
    return saved
  }
  try {
    return { server: await importer(await agentMcpImportHost(context.runtime), key, add) }
  } catch (error) {
    if (error instanceof AgentMcpServerImportError) {
      throw error.reason === 'gone' ? new McpServersError('mcp_server_gone', error.message) : error
    }
    if (!added) {
      throw error
    }
    // It's in Orca's list now even though an agent file kept its copy: every client re-reads.
    context.runtime.notifyMcpServersChanged()
    throw error instanceof AgentMcpConfigEditError ? new Error(editFailure(error)) : error
  }
}
