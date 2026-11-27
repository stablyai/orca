// Which workspace an `orca mcp` bridge's session is in, one rule for `connect`, `exec` and `env`:
// what its launch named (`--workspace`, or `--outside-workspace` for a pane in none), else the Orca
// pane's own (WSL forwards it), else the one holding cwd (an agent's own MCP file names neither).
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveCurrentWorktreeSelection } from '../workspace-selection/workspace-selector'

/** The workspace id; null outside every workspace, undefined when cwd can't be pinned to one
 *  (two repos claim it). */
export async function mcpCallerWorkspace(
  client: RuntimeClient,
  cwd: string,
  given: { workspace: string | undefined; outside: boolean }
): Promise<string | null | undefined> {
  // A terminal's launch names the workspace it chose the server by, or that it chose by none.
  if (given.outside) {
    return null
  }
  const named = given.workspace?.trim() || process.env.ORCA_WORKSPACE_ID?.trim()
  if (named) {
    return named
  }
  try {
    return (await resolveCurrentWorktreeSelection(cwd, client, 'current')).worktreeId
  } catch (error) {
    if (!(error instanceof RuntimeClientError) || !error.code.startsWith('selector_')) {
      throw error
    }
    // Outside every workspace, the server follows its "workspaces added later" choice.
    return error.code === 'selector_not_found' ? null : undefined
  }
}
