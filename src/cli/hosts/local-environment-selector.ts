import { normalizeTypedName } from '../../shared/typed-name-normalization'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { quoteCliCommandArgument } from '../arguments/shell-command-quote'

/** `--environment local`: the caller's own Orca, even over an ambient ORCA_ENVIRONMENT or pairing code. */
export const LOCAL_ENVIRONMENT = 'local'

export function isLocalEnvironmentSelector(value: unknown): value is string {
  return typeof value === 'string' && normalizeTypedName(value) === LOCAL_ENVIRONMENT
}

/** `local` is reserved, so a saved entry named local is reached only by its id. */
export async function savedEnvironmentNamedLocal(): Promise<{ id: string } | undefined> {
  const [{ getDefaultUserDataPath }, { listEnvironments }] = await Promise.all([
    import('../runtime/profile/metadata.js'),
    import('../../shared/remote-runtime/host-store/runtime-environment-store.js')
  ])
  return listEnvironments(getDefaultUserDataPath()).find((environment) =>
    isLocalEnvironmentSelector(environment.name)
  )
}

/** `orca environment …` takes --environment as a saved entry to act on; local is not one. */
export async function refuseLocalManagementSelector(
  commandPath: readonly string[],
  flags: Map<string, string | boolean>
): Promise<void> {
  if (commandPath[0] !== 'environment' || !isLocalEnvironmentSelector(flags.get('environment'))) {
    return
  }
  const named = await savedEnvironmentNamedLocal()
  throw new RuntimeClientError(
    'invalid_argument',
    `--environment local names this machine's own Orca, not a saved environment, so \`orca ${commandPath.join(' ')}\` cannot act on it.`,
    {
      nextSteps: [
        ...(named
          ? [`A saved environment named local is reached by its id: --environment ${named.id}.`]
          : []),
        'Run `orca environment list` to see saved environments.'
      ]
    }
  )
}

export function refuseReservedEnvironmentName(name: string): void {
  if (isLocalEnvironmentSelector(name)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '`local` is reserved: --environment local always means this machine’s own Orca. Save the environment under another name.'
    )
  }
}

/** cwd shortcuts (current, active) resolve only on the caller's own Orca. */
export function assertLocalCwdWorktreeSelector(selector: string, client: RuntimeClient): void {
  if (!client.isRemote) {
    return
  }
  // A paired CLI's cwd belongs to the client filesystem, so it cannot identify server worktrees.
  const environment = client.environmentSelector
  throw new RuntimeClientError(
    'invalid_argument',
    `${selector} is a local cwd shortcut and cannot be resolved against a remote runtime. Pass an explicit server-side worktree selector such as identity:<identity>, id:<repo-id>::<path>, folder:<id>, name:<displayName>, branch:<branch>, issue:<number>, or path:<absolute-server-path>.`,
    {
      nextSteps: [
        environment
          ? `List that environment's workspaces: \`orca worktree ps --environment ${quoteCliCommandArgument(environment)} --json\`, then copy a row's address.`
          : 'Save this connection with `orca environment add --name <name> --pairing-code <code>`, then list its workspaces with `orca worktree ps --environment <name> --json`.',
        `For this machine's own workspace, rerun with --environment local.`
      ]
    }
  )
}
