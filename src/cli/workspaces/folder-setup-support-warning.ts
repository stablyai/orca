import type { RuntimeClient } from '../runtime/client'
import type { RuntimeStatus } from '../../shared/runtime-session-contracts'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import { WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'

const FOLDER_SETUP_UNSUPPORTED_WARNING =
  'Setup did not run: this host runs an older Orca without folder workspace setup. Update Orca on that host to run it.'

/** An older host makes folder workspaces without running setup; say so rather than imply it ran. */
export async function folderSetupUnsupportedWarning(
  client: RuntimeClient,
  worktreeId: string | undefined,
  create: { setupDecision?: unknown; runHooks?: unknown }
): Promise<string | null> {
  const setupRequested = create.setupDecision === 'run' || create.runHooks === true
  if (!setupRequested || !worktreeId?.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
    return null
  }
  const status = await client.call<RuntimeStatus>('status.get').catch(() => null)
  return status && !status.result.capabilities?.includes(WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY)
    ? FOLDER_SETUP_UNSUPPORTED_WARNING
    : null
}

/** Joins the warning onto a create result, so text output and --json both carry it. */
export async function withFolderSetupSupportWarning<
  T extends { worktree?: { id?: string }; warning?: string }
>(
  client: RuntimeClient,
  result: T,
  create: { setupDecision?: unknown; runHooks?: unknown }
): Promise<T> {
  const warning = await folderSetupUnsupportedWarning(client, result.worktree?.id, create)
  return warning
    ? { ...result, warning: result.warning ? `${result.warning} ${warning}` : warning }
    : result
}
