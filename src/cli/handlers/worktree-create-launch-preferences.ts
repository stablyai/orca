import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { getOptionalStringFlag } from '../flags'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { WORKTREE_CREATE_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

/** `--model` / `--effort` as `worktree.create`'s `startupLaunchPreferences`. The host checks the
 *  values against the agent's catalog, as it does for `worker-start`. */
export async function getOptionalStartupLaunchPreferences(
  flags: Map<string, string | boolean>,
  startupAgent: string | undefined,
  client: RuntimeClient
): Promise<{ model?: string; effort?: string } | undefined> {
  const model = getOptionalStringFlag(flags, 'model')
  const effort = getOptionalStringFlag(flags, 'effort')
  if (!model && !effort) {
    return undefined
  }
  if (!startupAgent) {
    throw new RuntimeClientError('invalid_argument', '--model and --effort require --agent')
  }
  // Why: an older host strips the field it does not know and would start the agent on its
  // default model while the create still reports success.
  const status = await client.call<RuntimeStatus>('status.get')
  if (
    !status.result.capabilities?.includes(WORKTREE_CREATE_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The connected Orca runtime does not support --model or --effort on worktree create. Update or restart Orca and try again.'
    )
  }
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}
