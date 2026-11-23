import { AZURE_BOARDS_AGENT_ACCESS_RUNTIME_CAPABILITY } from '../../shared/azure-devops/azure-boards-agent-types'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { getOptionalStringFlag } from '../arguments/flags'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveCurrentWorktreeSelection } from '../workspace-selection/workspace-selector'

/** The repo selector every Azure Boards call is scoped to, after checking the host can serve it. */
export async function resolveAzureBoardsRepo(context: HandlerContext): Promise<string> {
  const runtime = await context.client.call<RuntimeStatus>('status.get')
  if (!runtime.result.capabilities?.includes(AZURE_BOARDS_AGENT_ACCESS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update Orca on the execution host to use Azure Boards commands.'
    )
  }
  const explicit = getOptionalStringFlag(context.flags, 'repo')?.trim()
  if (explicit) {
    return explicit
  }
  const { worktreeId } = await resolveCurrentWorktreeSelection(context.cwd, context.client)
  // Worktree ids are `<repoId>::<path>`; Boards only need the repo's remote.
  return `id:${worktreeId.slice(0, worktreeId.indexOf('::'))}`
}
