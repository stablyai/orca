import type { RuntimeManagedWorktreeCreateArgs } from '../workspaces/creation/runtime-managed-worktree-create-types'

export function suppressPipelineStartup(
  args: RuntimeManagedWorktreeCreateArgs,
  pipeline: NonNullable<RuntimeManagedWorktreeCreateArgs['pipeline']>,
  creationId: string
): RuntimeManagedWorktreeCreateArgs {
  return {
    ...args,
    pipeline,
    creationId,
    startup: undefined,
    startupAgent: undefined,
    startupPrompt: undefined,
    startupDraft: undefined,
    startupDraftPaste: undefined,
    createdWithAgent: undefined,
    promisedAgentChat: true,
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    setupOnly: true
  }
}
