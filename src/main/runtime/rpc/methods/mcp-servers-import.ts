// mcpServers.discover/move/copy: the "In your agents" servers on this host, and bringing one into
// the host list. Only reached through mcpServers.*, which refuses while the switch is off.
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { MCP_FILE_AGENTS, type McpServer } from '../../../../shared/mcp-servers/mcp-servers'
import { agentMcpServerMergeKey } from '../../../../shared/mcp/agent-mcp-config-entry'
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
  type AgentMcpImportHost,
  type AgentMcpReach
} from '../../../mcp-servers/agent-configs/agent-mcp-import'
import { AgentMcpConfigEditError } from '../../../mcp-servers/agent-configs/agent-mcp-config-removal'
import { hasMcpAgentProblem } from '../../../mcp-servers/mcp-agent-problems'
import { terminalMcpAdapterFor } from '../../../mcp-servers/terminal/terminal-mcp-adapters'
import { addMcpServers } from '../../../mcp-servers/mcp-host-list-add'
import { findOwnMcpServer, readMcpAgentFiles } from '../../../mcp-servers/mcp-host-list-file-reads'
import { McpServersError } from '../../../mcp-servers/mcp-servers-error'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

export { copyAgentMcpServer, listAgentMcpServers, moveAgentMcpServer }

const isLocal = (executionHostId: string | null | undefined): boolean =>
  executionHostId == null || parseExecutionHostId(executionHostId)?.kind === 'local'

/**
 * Which agents' new sessions on this host get its list: Grok, Cursor and Droid once the user let
 * Orca into their own file, the others when their terminal takes the servers and no launch learned
 * otherwise. Orca launches no other agent (Gemini CLI) with the list.
 */
async function hostListReaches(agents: readonly string[]): Promise<AgentMcpReach> {
  // The consent is read only when a file-based agent is asked about.
  const asksFiles = agents.some((agent) => MCP_FILE_AGENTS.some((fileAgent) => fileAgent === agent))
  const agentFiles = asksFiles ? await readMcpAgentFiles() : null
  return (agent) => {
    const fileAgent = MCP_FILE_AGENTS.find((candidate) => candidate === agent)
    if (fileAgent) {
      return agentFiles?.[fileAgent] === true
    }
    return isTuiAgent(agent) && terminalMcpAdapterFor(agent) !== null && !hasMcpAgentProblem(agent)
  }
}

/** This host's repos, their worktrees and folder workspaces: what a Claude project path maps to. */
export function agentMcpImportHost(runtime: OrcaRuntimeService): AgentMcpImportHost {
  return localAgentMcpImportHost(
    getAppEnvironment().getPath('userData'),
    async () => {
      const store = runtime.requireStore()
      const repos = store.getRepos().filter(isRepoOnCatalogHost)
      const local = new Set(repos.map((repo) => repo.id))
      const { worktrees } = await runtime.listManagedWorktrees(undefined, Number.MAX_SAFE_INTEGER)
      return workspaceForPathIn({
        repos,
        worktrees: worktrees.filter(
          (worktree) => local.has(worktree.repoId) && isLocal(worktree.hostId)
        ),
        folderWorkspaces: (store.getFolderWorkspaces?.() ?? []).filter(
          (folder) => !folder.connectionId && isLocal(folder.executionHostId)
        )
      })
    },
    hostListReaches
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
  add: AddImportedMcpServer<McpServer>,
  confirmed?: readonly string[]
) => Promise<McpServer>

/**
 * Adds the discovered server to the host list (scoped like its agent copy) by `importer`. `agents`:
 * the ones a Move's confirm named, which bound the copies it takes out.
 */
export async function importAgentMcpServer(
  context: RpcContext,
  { key, agents }: { key: string; agents?: readonly string[] },
  importer: AgentMcpImport
): Promise<{ server: McpServer }> {
  let added = false
  const add: AddImportedMcpServer<McpServer> = async (
    server,
    { workspaces, agentsOff },
    keepsCopies
  ) => {
    // Already Orca's (a copy an agent Orca's list doesn't reach kept after a Move): nothing is added
    // twice. A Move that takes copies out adds its own, scoped like them: Orca's may reach less.
    const definition = agentMcpServerMergeKey('', server)
    const existing = keepsCopies
      ? await findOwnMcpServer((own) => agentMcpServerMergeKey('', own) === definition)
      : null
    if (existing) {
      return existing
    }
    // Its scope goes in with it, so it's never on wider than its agent copy was.
    const [saved] = await addMcpServers([server], {
      nameGiven: false,
      signal: context.signal,
      ...(workspaces ? { workspaces } : {}),
      agentsOff
    })
    added = true
    return saved!
  }
  try {
    return { server: await importer(agentMcpImportHost(context.runtime), key, add, agents) }
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
