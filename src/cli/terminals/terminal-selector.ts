import type { RuntimeClient } from '../runtime/client'
import { getPresentStringFlag } from '../arguments/flags'
import type { WorkspaceSelectionPurpose } from '../workspace-selection/caller-host-worktree-selection'
import { getBrowserWorktreeSelector } from '../workspace-selection/workspace-selector'

export async function getTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient,
  options: { requireUnambiguous?: boolean; purpose?: WorkspaceSelectionPurpose } = {}
): Promise<string> {
  const explicit = getPresentStringFlag(flags, 'terminal')
  if (explicit) {
    return explicit
  }
  const worktree = await getBrowserWorktreeSelector(flags, cwd, client, options.purpose)
  const response = await client.call<{ handle: string }>('terminal.resolveActive', {
    worktree,
    ...(options.requireUnambiguous ? { requireUnambiguous: true } : {})
  })
  return response.result.handle
}
