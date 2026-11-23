import { relativePathInsideRoot } from '../../../../shared/file-access/cross-platform-path'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { isFloatingWorkspaceSelector } from '../../../../shared/workspace/identity/floating-workspace-worktree'

/** A floating workspace, or a create that names a folder, runs where this resolves; others need no pin. */
export async function launchDirectoryForCreate(
  input: { worktree: string; launchDirectory?: string },
  resolveWorkspacePath: (worktree: string) => Promise<string>
): Promise<string | undefined> {
  const floating = isFloatingWorkspaceSelector(input.worktree)
  if (!floating && !input.launchDirectory) {
    return undefined
  }
  return launchDirectoryInsideWorkspace(
    await resolveWorkspacePath(input.worktree),
    input.launchDirectory,
    floating
  )
}

/**
 * Where a new chat runs: a floating workspace pins its root; a requested folder (a task group's)
 * must sit inside the workspace, and the workspace root itself needs no pin.
 */
export function launchDirectoryInsideWorkspace(
  workspacePath: string,
  requested: string | undefined,
  floating: boolean
): string | undefined {
  const relative = requested ? relativePathInsideRoot(workspacePath, requested) : ''
  if (relative === null) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  if (relative === '') {
    return floating ? workspacePath : undefined
  }
  return requested
}
