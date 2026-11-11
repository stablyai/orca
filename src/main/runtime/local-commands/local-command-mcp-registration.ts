import { access } from 'node:fs/promises'
import {
  LOCAL_COMMAND_APPROVAL_WINDOW_MS,
  LOCAL_COMMAND_MAX_TIMEOUT_SEC,
  LOCAL_COMMAND_MCP_SERVER_NAME,
  LOCAL_COMMAND_RESULT_GRACE_MS
} from '../../../shared/local-commands/local-command-contract'
import { getAppEnvironment } from '../../../shared/app-environment'
import {
  defaultHostMcpSyncPaths,
  syncHostMcpServers,
  type HostMcpSyncDeps
} from '../../agent-mcp-sync/host/host-mcp-sync'

/** Its own ledger and Codex block, so a desktop's MCP sync never removes it and it never removes theirs. */
const SYNCER = 'orca-local-commands'
/** The golden image's CLI; agent shells may not have /opt/orca/bin on PATH. */
const VM_ORCA_CLI = '/opt/orca/bin/orca'
// Codex stops waiting on a tool after 60 s by default; a request waits minutes for the person.
const TOOL_TIMEOUT_SEC = Math.ceil(
  (LOCAL_COMMAND_APPROVAL_WINDOW_MS + 2 * LOCAL_COMMAND_RESULT_GRACE_MS) / 1000 +
    LOCAL_COMMAND_MAX_TIMEOUT_SEC
)

/** Gives every agent CLI on this cloud workspace the run_local_command tool. Logs counts only. */
export async function registerLocalCommandMcpServer(
  deps: Partial<HostMcpSyncDeps> = {}
): Promise<void> {
  const server = {
    command: (await access(VM_ORCA_CLI).then(
      () => true,
      () => false
    ))
      ? VM_ORCA_CLI
      : 'orca',
    args: ['local-command', 'mcp']
  }
  await syncHostMcpServers(
    {
      claude: { [LOCAL_COMMAND_MCP_SERVER_NAME]: { type: 'stdio', ...server } },
      codex: {
        [LOCAL_COMMAND_MCP_SERVER_NAME]: { ...server, tool_timeout_sec: TOOL_TIMEOUT_SEC }
      },
      syncer: SYNCER
    },
    {
      paths: deps.paths ?? defaultHostMcpSyncPaths(getAppEnvironment().getPath('userData')),
      ...(deps.commandExists ? { commandExists: deps.commandExists } : {}),
      resolves: async () => true
    }
  )
}
