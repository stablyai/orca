import type { RuntimeClient } from '../runtime-client'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import { WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'

/** An older host makes folder workspaces without running setup; say so rather than imply it ran. */
export async function warnIfFolderSetupUnsupported(
  client: RuntimeClient,
  worktreeId: string | undefined,
  setupRequested: boolean,
  json: boolean
): Promise<void> {
  if (json || !setupRequested || !worktreeId?.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
    return
  }
  const status = await client.call<RuntimeStatus>('status.get').catch(() => null)
  if (status && !status.result.capabilities?.includes(WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY)) {
    console.error(
      'warning: Setup did not run: this host runs an older Orca without folder workspace setup. Update Orca on that host to run it.'
    )
  }
}
